import { readMultipartFormData, getRouterParam, setResponseHeader, getRequestURL, createError } from 'h3'
import path from 'path'
import { randomUUID } from 'crypto'
import { getStorageDir, findUploadBySlug, findUserById, updateEntryPointIfUnchanged } from '~/server/utils/db'
import {
  createStagingDir,
  publishStagedDir,
  removeContentDir,
  retireContentPath,
  pruneStaging,
  pruneTrash,
} from '~/server/utils/storage'
import {
  writeUploadContent,
  isAcceptedUploadFilename,
  resolveUploadMaxBytes,
} from '~/server/utils/upload-content'
import { authorizeContentUpdate } from '~/server/utils/update-auth'
import { checkUploadRateLimit, getClientIP } from '~/server/utils/rate-limit'
import { hasValidApiToken } from '~/server/utils/upload-auth'
import { verifyTurnstileToken } from '~/server/utils/turnstile'
import { getUserIdFromEvent } from '~/server/utils/user-auth'

const STORAGE = getStorageDir()

function pathRelativeToStorage(absolutePath: string): string {
  return path.relative(STORAGE, absolutePath).split(path.sep).join('/')
}

function readFormField(form: Awaited<ReturnType<typeof readMultipartFormData>>, name: string): string {
  const field = form?.find((f) => f.name === name && typeof f.data === 'object')
  return field?.data && Buffer.isBuffer(field.data) ? field.data.toString('utf8').trim() : ''
}

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')
  if (!slug) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  const row = findUploadBySlug(slug)
  if (!row) {
    throw createError({ statusCode: 404, message: 'Site not found' })
  }
  if (row.expires_at && new Date(row.expires_at) <= new Date()) {
    throw createError({ statusCode: 404, message: 'Site has expired' })
  }

  const ip = getClientIP(event)
  const { allowed, retryAfter } = checkUploadRateLimit(ip)
  if (!allowed) {
    const err = createError({
      statusCode: 429,
      statusMessage: 'Too Many Requests',
      message: `Rate limit exceeded. Try again in ${retryAfter ?? 60} seconds.`,
    })
    if (retryAfter) {
      setResponseHeader(event, 'Retry-After', String(retryAfter))
    }
    throw err
  }

  const form = await readMultipartFormData(event)
  if (!form || form.length === 0) {
    throw createError({ statusCode: 400, message: 'No file in request' })
  }

  const ownerToken = readFormField(form, 'owner_token')
  authorizeContentUpdate(event, row, ownerToken)

  const file = form.find((f) => f.name === 'file')
  if (!file?.data) {
    throw createError({ statusCode: 400, message: 'Missing file' })
  }

  if (!hasValidApiToken(event)) {
    const turnstileToken = readFormField(form, 'cf-turnstile-response')
    const turnstileOk = await verifyTurnstileToken(turnstileToken || undefined, ip)
    if (!turnstileOk) {
      throw createError({ statusCode: 400, message: 'Captcha verification failed. Please try again.' })
    }
  }

  const filename = (file.filename || 'file').toLowerCase()
  if (!isAcceptedUploadFilename(filename)) {
    throw createError({ statusCode: 400, message: 'Only .html, .zip, or .md files are allowed' })
  }

  const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data as ArrayBuffer)
  const config = useRuntimeConfig()
  const userId = getUserIdFromEvent(event) ?? null
  const user = userId ? findUserById(userId) : null
  const maxBytes = resolveUploadMaxBytes({
    userMaxBytes: user?.upload_max_bytes ?? null,
    isApi: hasValidApiToken(event),
    isZip: filename.endsWith('.zip'),
    configMaxBytes: config.jolthost?.uploadMaxBytes ?? 25 * 1024 * 1024,
  })
  if (data.length > maxBytes) {
    throw createError({
      statusCode: 413,
      message: `File too large. Maximum size is ${Math.round(maxBytes / 1024 / 1024)}MB.`,
    })
  }

  // Stage the complete replacement outside the served asset root.
  const stagingDir = createStagingDir()
  let entryRel: string
  try {
    entryRel = await writeUploadContent(data, filename, stagingDir)
  } catch (err) {
    removeContentDir(stagingDir)
    throw err
  }

  const uniqueId = randomUUID()
  let finalDir: string
  try {
    finalDir = publishStagedDir(stagingDir, slug, uniqueId)
  } catch {
    removeContentDir(stagingDir)
    throw createError({ statusCode: 500, message: 'Failed to store the replacement content.' })
  }

  const newEntryPoint = pathRelativeToStorage(path.join(finalDir, entryRel))

  // The conditional update is the publication switch.
  if (!updateEntryPointIfUnchanged(slug, row.entry_point, newEntryPoint)) {
    removeContentDir(finalDir)
    const current = findUploadBySlug(slug)
    if (!current || (current.expires_at && new Date(current.expires_at) <= new Date())) {
      throw createError({ statusCode: 404, message: 'Site is no longer available' })
    }
    throw createError({
      statusCode: 409,
      message: 'This site was updated by another request. Reload and try again.',
    })
  }

  // Retire the former content for a bounded period, then prune abandoned files.
  const formerDir = path.dirname(path.join(STORAGE, row.entry_point))
  if (formerDir !== STORAGE && formerDir.startsWith(STORAGE + path.sep)) {
    retireContentPath(formerDir)
  }
  pruneStaging()
  pruneTrash()

  const baseUrl = getRequestURL(event).origin
  return {
    slug,
    url: `${baseUrl}/view/${slug}`,
    entry_point: newEntryPoint,
  }
})
