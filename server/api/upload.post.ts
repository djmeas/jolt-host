import { readMultipartFormData, setResponseHeader } from 'h3'
import { createWriteStream, mkdirSync, existsSync } from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import { randomUUID, randomBytes } from 'crypto'
import unzipper from 'unzipper'
import { getStorageDir, insertUpload, slugExists } from '~/server/utils/db'
import { generateUniqueSlug } from '~/server/utils/slug'
import { hashPassword } from '~/server/utils/password'
import { createUnlockToken } from '~/server/utils/view-auth'
import { checkUploadRateLimit, getClientIP } from '~/server/utils/rate-limit'
import { isAuthorizedToUpload, hasValidApiToken } from '~/server/utils/upload-auth'
import { verifyTurnstileToken } from '~/server/utils/turnstile'

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

function pathRelativeToStorage(absolutePath: string): string {
  const rel = path.relative(STORAGE, absolutePath)
  return rel.split(path.sep).join('/')
}

export default defineEventHandler(async (event) => {
  if (!isAuthorizedToUpload(event)) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Unauthorized',
      message: 'API token required for programmatic uploads. Use the web form at / or provide an API token in the Authorization header.',
    })
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

  if (!hasValidApiToken(event)) {
    const turnstileField = form?.find((f) => f.name === 'cf-turnstile-response')
    const turnstileToken = turnstileField?.data ? Buffer.isBuffer(turnstileField.data) ? turnstileField.data.toString('utf8').trim() : '' : ''
    const turnstileOk = await verifyTurnstileToken(turnstileToken || undefined, ip)
    if (!turnstileOk) {
      throw createError({ statusCode: 400, message: 'Captcha verification failed. Please try again.' })
    }
  }

  const file = form.find((f) => f.name === 'file' || f.data)
  if (!file?.data) {
    throw createError({ statusCode: 400, message: 'Missing file' })
  }

  const passwordField = form.find((f) => f.name === 'password' && typeof f.data === 'object')
  const passwordRaw = passwordField?.data
  const password = passwordRaw && Buffer.isBuffer(passwordRaw) ? passwordRaw.toString('utf8').trim() : ''
  const passwordHash = password.length > 0 ? hashPassword(password) : null
  if (password.length > 0 && password.length > 200) {
    throw createError({ statusCode: 400, message: 'Password too long' })
  }

  const expirationField = form.find((f) => f.name === 'expiration' && typeof f.data === 'object')
  const expirationRaw = expirationField?.data
  const expiration = expirationRaw && Buffer.isBuffer(expirationRaw) ? expirationRaw.toString('utf8').trim() : ''
  const expiresAt = parseExpirationToISO(expiration)
  if (expiration && !expiresAt) {
    throw createError({ statusCode: 400, message: 'Invalid expiration value' })
  }

  const filename = (file.filename || 'file').toLowerCase()
  const config = useRuntimeConfig()
  const maxBytes = config.jolthost?.uploadMaxBytes ?? 25 * 1024 * 1024
  const fileSize = Buffer.isBuffer(file.data) ? file.data.length : (file.data as Uint8Array).length
  if (fileSize > maxBytes) {
    throw createError({
      statusCode: 413,
      message: `File too large. Maximum size is ${Math.round(maxBytes / 1024 / 1024)}MB.`,
    })
  }

  if (!filename.endsWith('.html') && !filename.endsWith('.zip')) {
    throw createError({ statusCode: 400, message: 'Only .html or .zip files are allowed' })
  }

  const slug = generateUniqueSlug(slugExists)
  const id = randomUUID()
  const ownerToken = randomBytes(24).toString('base64url')
  const uploadDir = path.join(STORAGE, slug)

  if (!existsSync(uploadDir)) {
    mkdirSync(uploadDir, { recursive: true })
  }

  let entryPoint: string

  if (filename.endsWith('.html')) {
    const outPath = path.join(uploadDir, 'index.html')
    await pipeline(
      Readable.from(file.data),
      createWriteStream(outPath)
    )
    entryPoint = pathRelativeToStorage(outPath)
  } else {
    const buffer = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data as ArrayBuffer)
    let directory: Awaited<ReturnType<typeof unzipper.Open.buffer>>
    try {
      directory = await unzipper.Open.buffer(buffer)
    } catch (err) {
      throw createError({
        statusCode: 400,
        message: 'Invalid or corrupted ZIP file.',
      })
    }
    await directory.extract({ path: uploadDir })

    const htmlEntries = directory.files
      .filter((e) => e.type !== 'Directory' && e.path.toLowerCase().endsWith('.html'))
      .map((e) => e.path.replace(/\\/g, '/').replace(/^\/+/, ''))
      .sort((a, b) => {
        if (a.toLowerCase() === 'index.html') return -1
        if (b.toLowerCase() === 'index.html') return 1
        return a.localeCompare(b)
      })
    const entryFile = htmlEntries[0]
    if (!entryFile) {
      throw createError({ statusCode: 400, message: 'ZIP must contain at least one .html file' })
    }
    entryPoint = pathRelativeToStorage(path.join(uploadDir, entryFile))
  }

  insertUpload(id, slug, entryPoint, passwordHash, ownerToken, expiresAt)

  const baseUrl = getRequestURL(event).origin
  const url = `${baseUrl}/view/${slug}`
  const response: Record<string, string> = {
    slug,
    url,
    entry_point: entryPoint,
    owner_token: ownerToken,
    url_with_owner_token: `${url}?owner_token=${encodeURIComponent(ownerToken)}`,
  }
  if (password.length > 0) {
    const unlockToken = createUnlockToken(slug, expiresAt)
    response.url_with_unlock = `${url}?unlock=${encodeURIComponent(unlockToken)}`
  }
  return response
})
