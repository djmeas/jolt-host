import { createError, getQuery, getRequestHeader, setHeader, setResponseStatus } from 'h3'
import type { H3Event } from 'h3'
import type { UploadRow } from '~/server/utils/db'
import { getDataSessionKey, hasValidDataSession } from '~/server/utils/data-auth'
import { isViewAuthorized } from '~/server/utils/view-auth'
import { requireExactOrigin } from '~/server/utils/site-host'
import {
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
} from '~/server/utils/site-data'

/** Request bodies are bounded before parsing, not after. */
export const DATA_BODY_MAX_BYTES = 8 * 1024
/** Absolute drain ceiling: larger bodies drop the connection instead of streaming forever. */
const DATA_BODY_DRAIN_CEILING_BYTES = 256 * 1024

export const DATA_LOGIN_URL = '/_jolt/data/login'

type ErrorLike = { statusCode?: number; message?: string; data?: unknown }

/**
 * The data API always answers JSON, including for errors, because its callers
 * are scripts running inside an uploaded site rather than Jolt's own UI.
 */
export async function runDataApi(
  event: H3Event,
  handler: () => Promise<unknown> | unknown
): Promise<unknown> {
  try {
    return await handler()
  } catch (err) {
    const candidate = err as ErrorLike
    const statusCode =
      typeof candidate?.statusCode === 'number' && candidate.statusCode >= 400
        ? candidate.statusCode
        : 500
    const message =
      typeof candidate?.message === 'string' && candidate.message
        ? candidate.message
        : 'Internal error'
    if (statusCode >= 500) console.error('[site-data]', err)
    const extra =
      candidate?.data && typeof candidate.data === 'object' ? (candidate.data as object) : {}
    if (statusCode === 429 && 'retry_after' in extra) {
      setHeader(event, 'Retry-After', String((extra as { retry_after: number }).retry_after))
    }
    setHeader(event, 'Cache-Control', 'no-store')
    setHeader(event, 'Content-Type', 'application/json; charset=utf-8')
    setResponseStatus(event, statusCode)
    return { error: message, ...extra }
  }
}

/**
 * Reads a JSON body with a hard byte bound. Oversized bodies are drained (up to
 * a ceiling) so the client reliably receives the 413 rather than a reset.
 */
export async function readBoundedJson(event: H3Event, maxBytes: number): Promise<unknown> {
  const declared = getRequestHeader(event, 'content-length')
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    throw createError({ statusCode: 413, message: 'Request body is too large' })
  }
  const stream = event.node.req
  const chunks: Buffer[] = []
  let total = 0
  let overflowed = false
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer)
    total += buffer.length
    if (total > maxBytes) {
      overflowed = true
      if (total > DATA_BODY_DRAIN_CEILING_BYTES) {
        stream.destroy()
        throw createError({ statusCode: 413, message: 'Request body is too large' })
      }
      continue
    }
    chunks.push(buffer)
  }
  if (overflowed) {
    throw createError({ statusCode: 413, message: 'Request body is too large' })
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) {
    throw createError({ statusCode: 400, message: 'A JSON body is required' })
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw createError({ statusCode: 400, message: 'Request body must be valid JSON' })
  }
}

export function requireJsonContentType(event: H3Event): void {
  const contentType = (getRequestHeader(event, 'content-type') ?? '').toLowerCase()
  if (!contentType.startsWith('application/json')) {
    throw createError({ statusCode: 400, message: 'Content-Type must be application/json' })
  }
}

/** Mutations carry `{ "value": { ... } }` and nothing else. */
export function extractRecordValue(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('value' in body)) {
    throw createError({
      statusCode: 400,
      message: 'A JSON body with a "value" object is required',
    })
  }
  return body.value
}

export function requireDataEnabled(row: UploadRow): void {
  // Fail closed when the password is gone: a still-valid view cookie must not
  // read rows from a site whose password was cleared (which disables data).
  if (!row.data_enabled || !row.password_hash) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }
}

/** Reads need a site view credential (password or unlock link) or a data session. */
export function requireDataReadAccess(event: H3Event, row: UploadRow): void {
  if (hasValidDataSession(event, row)) return
  if (isViewAuthorized(event, row.slug)) return
  throw createError({
    statusCode: 401,
    message: 'Authentication required',
    data: { login_url: DATA_LOGIN_URL },
  })
}

/**
 * Writes require a data-admin session issued by the Jolt password form. A view
 * cookie, unlock link, owner token, app session, or API token never qualifies.
 * Returns the session key used for write rate limiting.
 */
export function requireDataWriteAccess(event: H3Event, row: UploadRow, origin: string): string {
  requireExactOrigin(event, origin)
  if (!hasValidDataSession(event, row)) {
    if (isViewAuthorized(event, row.slug)) {
      throw createError({
        statusCode: 403,
        message: 'This session can read site data but not modify it',
      })
    }
    throw createError({
      statusCode: 401,
      message: 'Authentication required',
      data: { login_url: DATA_LOGIN_URL },
    })
  }
  return getDataSessionKey(event)
}

type PageParams = { limit: number; offset: number }

export function parseListParams(event: H3Event): PageParams {
  const query = getQuery(event)
  const rawLimit = Array.isArray(query.limit) ? query.limit[0] : query.limit
  const rawOffset = Array.isArray(query.offset) ? query.offset[0] : query.offset

  let limit = LIST_DEFAULT_LIMIT
  if (rawLimit !== undefined && rawLimit !== '') {
    limit = Number(rawLimit)
    if (!Number.isInteger(limit) || limit < 1 || limit > LIST_MAX_LIMIT) {
      throw createError({
        statusCode: 400,
        message: `limit must be an integer between 1 and ${LIST_MAX_LIMIT}`,
      })
    }
  }

  let offset = 0
  if (rawOffset !== undefined && rawOffset !== '') {
    offset = Number(rawOffset)
    if (!Number.isInteger(offset) || offset < 0) {
      throw createError({ statusCode: 400, message: 'offset must be a nonnegative integer' })
    }
  }

  return { limit, offset }
}
