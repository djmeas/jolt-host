/**
 * Single source of truth for the upload creation policy: authorization, the
 * per-IP upload rate limit, Turnstile policy, password hashing, data opt-in
 * validation, expiration parsing, size limits, canonical-URL fail-closed
 * checking, content writing, row insertion, and the public result shape.
 *
 * `/api/upload` (multipart) and `/api/ai/preview` (JSON workspace) are thin
 * adapters that only turn their transport into `CreateUploadInput`; neither may
 * restate or bypass these rules. Attribution is always resolved from the
 * request itself, never from a caller-supplied user ID.
 */

import { createError, setResponseHeader } from 'h3'
import type { H3Event } from 'h3'
import { mkdirSync, existsSync } from 'fs'
import path from 'path'
import { randomUUID, randomBytes } from 'crypto'
import {
  getStorageDir,
  insertUpload,
  slugExists,
  findUserById,
  enableDataBySlug,
  findUploadBySlug,
  updateEntryPointIfUnchanged,
} from '~/server/utils/db'
import {
  createStagingDir,
  publishStagedDir,
  removeContentDir,
  retireContentPath,
  pruneStaging,
  pruneTrash,
} from '~/server/utils/storage'
import { generateUniqueSlug } from '~/server/utils/slug'
import { hashPassword } from '~/server/utils/password'
import { createUnlockToken } from '~/server/utils/view-auth'
import { canonicalSiteUrl, getSiteHostConfig } from '~/server/utils/site-host'
import { checkUploadRateLimit, getClientIP } from '~/server/utils/rate-limit'
import { requireUploadAuthorization, hasValidApiToken, resolveUploadUserId } from '~/server/utils/upload-auth'
import { authorizeContentUpdate } from '~/server/utils/update-auth'
import { verifyTurnstileToken } from '~/server/utils/turnstile'
import { writeUploadContent, isAcceptedUploadFilename, resolveUploadMaxBytes } from '~/server/utils/upload-content'
import { dataApiToggleEnabled } from '~/server/utils/upload-mode'
import { getDataFeatureStatus } from '~/server/utils/data-auth'
import { getUserIdFromEvent } from '~/server/utils/user-auth'

const STORAGE = getStorageDir()

/** Parses expiration form value (1h, 8h, 24h, 1w or empty) to ISO datetime or null. */
function parseExpirationToISO(value: string): string | null {
  if (!value) return null
  const now = Date.now()
  let ms = 0
  const match = value.match(/^(\d+)(h|w|d)$/i)
  if (!match) return null
  const n = parseInt(match[1], 10)
  const unit = match[2].toLowerCase()
  if (unit === 'h') ms = n * 60 * 60 * 1000
  else if (unit === 'd') ms = n * 24 * 60 * 60 * 1000
  else if (unit === 'w') ms = n * 7 * 24 * 60 * 60 * 1000
  else return null
  return new Date(now + ms).toISOString()
}

/** Transport-neutral creation input. Values are semantic, not transport-specific. */
export type CreateUploadInput = {
  /** The exact bytes to publish, or null when the request carried no file. */
  data: Buffer | null
  /** The multipart adapter saw a form with no parts at all. */
  emptyForm?: boolean
  /** Original filename; the `.html`/`.zip`/`.md` extension selects how it is written. */
  filename: string
  title?: string | null
  password?: string
  expiration?: string
  enableData?: boolean
  /** Cloudflare Turnstile widget token; ignored when an API token is present. */
  turnstileToken?: string
}

/** The exact public creation result returned by `/api/upload`. */
export type UploadResult = {
  slug: string
  url: string
  entry_point: string
  owner_token: string
  expires_at: string
  title: string
  data_enabled?: string
  url_with_unlock?: string
}

/** An error thrown by the creation pipeline, with the retry hint kept off the wire. */
export type UploadPublishFailure = Error & {
  statusCode: number
  statusMessage?: string
  retryAfter?: number
}

function failure(statusCode: number, message: string, retryAfter?: number): UploadPublishFailure {
  const error: UploadPublishFailure = createError({
    statusCode,
    ...(statusCode === 429 ? { statusMessage: 'Too Many Requests' } : {}),
    message,
  })
  // Nitro serializes only statusCode/statusMessage/message/stack, so this extra
  // hint never leaks into the public upload error body; the AI adapter uses it
  // to emit the documented top-level `retry_after`.
  if (retryAfter !== undefined) error.retryAfter = retryAfter
  return error
}

/** Narrows any thrown value to a creation-pipeline failure (an h3 error). */
export function isUploadPublishFailure(error: unknown): error is UploadPublishFailure {
  return error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number'
}

/**
 * Runs the whole creation pipeline and returns the standard creation result.
 *
 * Fail-closed ordering is deliberate: authorization and the rate limit run
 * before any body-derived work, the canonical hosted origin is verified before
 * anything is persisted, and data opt-in is validated before a row is written.
 */
export async function createUploadFromContent(event: H3Event, input: CreateUploadInput): Promise<UploadResult> {
  requireUploadAuthorization(event)

  const ip = getClientIP(event)
  const { allowed, retryAfter } = checkUploadRateLimit(ip)
  if (!allowed) {
    if (retryAfter) {
      setResponseHeader(event, 'Retry-After', String(retryAfter))
    }
    throw failure(429, `Rate limit exceeded. Try again in ${retryAfter ?? 60} seconds.`, retryAfter ?? undefined)
  }

  if (input.emptyForm) {
    throw failure(400, 'No file in request')
  }

  if (!hasValidApiToken(event)) {
    const turnstileToken = input.turnstileToken?.trim() ?? ''
    const turnstileOk = await verifyTurnstileToken(turnstileToken || undefined, ip)
    if (!turnstileOk) {
      throw failure(400, 'Captcha verification failed. Please try again.')
    }
  }

  if (!input.data) {
    throw failure(400, 'Missing file')
  }

  const password = (input.password ?? '').trim()
  const passwordHash = password.length > 0 ? hashPassword(password) : null
  if (password.length > 0 && password.length > 200) {
    throw failure(400, 'Password too long')
  }

  const enableDataRequested = input.enableData === true
  if (enableDataRequested) {
    if (!dataApiToggleEnabled()) {
      throw failure(403, 'The Data API opt-in is disabled on this deployment')
    }
    if (password.length === 0) {
      throw failure(400, 'The Data API requires a site password')
    }
    const feature = getDataFeatureStatus()
    if (!feature.enabled) {
      throw failure(503, feature.reason ?? 'Site data is not available on this deployment')
    }
  }

  const expiration = (input.expiration ?? '').trim()
  let expiresAt = parseExpirationToISO(expiration)
  if (expiration && !expiresAt) {
    throw failure(400, 'Invalid expiration value')
  }

  const title = input.title == null ? null : input.title.trim().slice(0, 100)

  const userId = resolveUploadUserId(event)
  const user = userId ? findUserById(userId) : null
  if (user && user.never_expire === 1) {
    expiresAt = null
  }

  const filename = input.filename.toLowerCase()
  if (!isAcceptedUploadFilename(filename)) {
    throw failure(400, 'Only .html, .zip, or .md files are allowed')
  }

  const config = useRuntimeConfig()
  const maxBytes = resolveUploadMaxBytes({
    userMaxBytes: user?.upload_max_bytes ?? null,
    isApi: hasValidApiToken(event),
    isZip: filename.endsWith('.zip'),
    configMaxBytes: config.jolthost?.uploadMaxBytes ?? 25 * 1024 * 1024,
  })
  const fileSize = input.data.length
  if (fileSize > maxBytes) {
    throw failure(413, `File too large. Maximum size is ${Math.round(maxBytes / 1024 / 1024)}MB.`)
  }

  const slug = generateUniqueSlug(slugExists)
  const id = randomUUID()
  const ownerToken = randomBytes(24).toString('base64url')

  // Fail closed before anything is persisted, so a misconfigured deployment can
  // never leave a published row and files with no canonical URL to return.
  const url = canonicalSiteUrl(slug)
  if (!url) {
    throw failure(
      503,
      `Hosted site origins are not configured on this server: ${getSiteHostConfig().reason ?? 'unknown reason'}`
    )
  }

  const uploadDir = path.join(STORAGE, slug)

  if (!existsSync(uploadDir)) {
    mkdirSync(uploadDir, { recursive: true })
  }

  const entryFile = await writeUploadContent(input.data, filename, uploadDir)
  const entryPoint = path.relative(STORAGE, path.join(uploadDir, entryFile)).split(path.sep).join('/')

  insertUpload(id, slug, entryPoint, passwordHash, ownerToken, expiresAt, userId, title || null)

  const dataEnabled = enableDataRequested ? enableDataBySlug(slug) : false

  const response: UploadResult = {
    slug,
    url,
    entry_point: entryPoint,
    owner_token: ownerToken,
    expires_at: expiresAt ?? '',
    title: title || '',
  }
  if (dataEnabled) {
    response.data_enabled = 'true'
  }
  if (password.length > 0) {
    const unlockToken = createUnlockToken(slug, expiresAt)
    response.url_with_unlock = `${url}?unlock=${encodeURIComponent(unlockToken)}`
  }
  return response
}

/** Transport-neutral replacement input. Trusted builder code owns the overrides. */
export type ReplaceUploadInput = {
  slug: string
  /** The exact bytes to publish, or null when the request carried no file. */
  data: Buffer | null
  /** Original filename; the `.html`/`.zip`/`.md` extension selects how it is written. */
  filename: string
  ownerToken?: string
  /** Cloudflare Turnstile widget token; ignored when an API token is present. */
  turnstileToken?: string
  /**
   * The entry point observed when the caller decided to replace. Defaults to the
   * row's current entry point, which is the ordinary public behavior. Trusted
   * builder code supplies the attach/last-success baseline so an intervening
   * external replacement is a conflict instead of being overwritten.
   */
  expectedEntryPoint?: string
  /**
   * The immutable upload id observed with the baseline. Trusted builder code
   * supplies it so a deleted-then-recreated slug cannot be replaced.
   */
  expectedUploadId?: string
  /**
   * Preserves an attached site's active entry file inside the archive. Only the
   * trusted builder path supplies it after its own eligibility check; public
   * multipart fields can never select it.
   */
  preferredEntryFile?: string
}

/** The exact public replacement result returned by the content PUT route. */
export type ReplaceUploadResult = { slug: string; url: string; entry_point: string }

/**
 * Runs the whole replacement pipeline and returns the standard replacement
 * result. The upload rate limit is applied by the adapters before any body is
 * buffered (so a rate-limited request never reads a file); everything else —
 * authorization, canonical-URL fail-closed checking, CAPTCHA, format/size,
 * staging, the conditional DB switch, and generation retirement — lives here so
 * ordinary multipart clients and the builder mode cannot drift.
 */
export async function replaceUploadFromContent(
  event: H3Event,
  input: ReplaceUploadInput
): Promise<ReplaceUploadResult> {
  const row = findUploadBySlug(input.slug)
  if (!row) {
    throw failure(404, 'Site not found')
  }
  if (row.expires_at && new Date(row.expires_at) <= new Date()) {
    throw failure(404, 'Site has expired')
  }

  authorizeContentUpdate(event, row, input.ownerToken ?? '', hasValidApiToken(event))

  // Fail closed before staging or switching anything: an unconfigured deployment
  // must not publish a replacement it cannot return a canonical URL for.
  const url = canonicalSiteUrl(input.slug)
  if (!url) {
    throw failure(
      503,
      `Hosted site origins are not configured on this server: ${getSiteHostConfig().reason ?? 'unknown reason'}`
    )
  }

  if (!input.data) {
    throw failure(400, 'Missing file')
  }

  if (!hasValidApiToken(event)) {
    const turnstileToken = (input.turnstileToken ?? '').trim()
    const turnstileOk = await verifyTurnstileToken(turnstileToken || undefined, getClientIP(event))
    if (!turnstileOk) {
      throw failure(400, 'Captcha verification failed. Please try again.')
    }
  }

  const filename = input.filename.toLowerCase()
  if (!isAcceptedUploadFilename(filename)) {
    throw failure(400, 'Only .html, .zip, or .md files are allowed')
  }

  const config = useRuntimeConfig()
  const userId = getUserIdFromEvent(event) ?? null
  const user = userId ? findUserById(userId) : null
  const maxBytes = resolveUploadMaxBytes({
    userMaxBytes: user?.upload_max_bytes ?? null,
    isApi: hasValidApiToken(event),
    isZip: filename.endsWith('.zip'),
    configMaxBytes: config.jolthost?.uploadMaxBytes ?? 25 * 1024 * 1024,
  })
  if (input.data.length > maxBytes) {
    throw failure(413, `File too large. Maximum size is ${Math.round(maxBytes / 1024 / 1024)}MB.`)
  }

  // Stage the complete replacement outside the served asset root.
  const stagingDir = createStagingDir()
  let entryRel: string
  try {
    entryRel = await writeUploadContent(
      input.data,
      filename,
      stagingDir,
      input.preferredEntryFile === undefined ? {} : { preferredEntryFile: input.preferredEntryFile }
    )
  } catch (err) {
    removeContentDir(stagingDir)
    throw err
  }

  const uniqueId = randomUUID()
  let finalDir: string
  try {
    finalDir = publishStagedDir(stagingDir, input.slug, uniqueId)
  } catch {
    removeContentDir(stagingDir)
    throw failure(500, 'Failed to store the replacement content.')
  }

  const newEntryPoint = path.relative(STORAGE, path.join(finalDir, entryRel)).split(path.sep).join('/')

  // The conditional update is the publication switch. Expected entry point and
  // immutable id default to the values just read, which is exactly the existing
  // public behavior; the builder path supplies the attach-time baseline.
  const expectedEntryPoint = input.expectedEntryPoint ?? row.entry_point
  const switched = updateEntryPointIfUnchanged(
    input.slug, expectedEntryPoint, newEntryPoint, input.expectedUploadId ?? row.id, row.user_id
  )
  if (!switched) {
    removeContentDir(finalDir)
    const current = findUploadBySlug(input.slug)
    if (!current || (current.expires_at && new Date(current.expires_at) <= new Date())) {
      throw failure(404, 'Site is no longer available')
    }
    throw failure(409, 'This site was updated by another request. Reload and try again.')
  }

  // Retire the former content for a bounded period, then prune abandoned files.
  const formerDir = path.dirname(path.join(STORAGE, row.entry_point))
  if (formerDir !== STORAGE && formerDir.startsWith(STORAGE + path.sep)) {
    retireContentPath(formerDir)
  }
  pruneStaging()
  pruneTrash()

  return { slug: input.slug, url, entry_point: newEntryPoint }
}
