import { readMultipartFormData, getRequestIP, setResponseHeader } from 'h3'
import { randomUUID } from 'crypto'
import { unzipSync } from 'fflate'
import mime from 'mime-types'
import { useR2 } from '~/server/utils/cf'
import { insertUpload, slugExists, findUserById } from '~/server/utils/db'
import { generateUniqueSlug } from '~/server/utils/slug'
import { hashPassword } from '~/server/utils/password'
import { createUnlockToken } from '~/server/utils/view-auth'
import { checkUploadRateLimit } from '~/server/utils/rate-limit'
import { isAuthorizedToUpload, hasValidApiToken } from '~/server/utils/upload-auth'
import { verifyTurnstileToken } from '~/server/utils/turnstile'
import { getUserIdFromEvent } from '~/server/utils/user-auth'

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

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export default defineEventHandler(async (event) => {
  if (!(await isAuthorizedToUpload(event))) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Unauthorized',
      message: 'API token required for programmatic uploads. Use the web form at / or provide an API token in the Authorization header.',
    })
  }

  const ip = getRequestIP(event) ?? 'unknown'
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

  if (!(await hasValidApiToken(event))) {
    const turnstileField = form?.find((f) => f.name === 'cf-turnstile-response')
    const turnstileToken = turnstileField?.data ? new TextDecoder().decode(turnstileField.data).trim() : ''
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
  const password = passwordRaw ? new TextDecoder().decode(passwordRaw).trim() : ''
  if (password.length > 200) {
    throw createError({ statusCode: 400, message: 'Password too long' })
  }
  const passwordHash = password.length > 0 ? await hashPassword(password) : null

  const expirationField = form.find((f) => f.name === 'expiration' && typeof f.data === 'object')
  const expirationRaw = expirationField?.data
  const expiration = expirationRaw ? new TextDecoder().decode(expirationRaw).trim() : ''
  let expiresAt = parseExpirationToISO(expiration)
  if (expiration && !expiresAt) {
    throw createError({ statusCode: 400, message: 'Invalid expiration value' })
  }

  const titleField = form.find((f) => f.name === 'title' && typeof f.data === 'object')
  const titleRaw = titleField?.data
  const title = titleRaw && Buffer.isBuffer(titleRaw) ? titleRaw.toString('utf8').trim().slice(0, 100) : null

  const userId = getUserIdFromEvent(event) ?? null
  const user = userId ? await findUserById(event, userId) : null
  if (user && user.never_expire === 1) {
    expiresAt = null
  }

  const filename = (file.filename || 'file').toLowerCase()
  const config = useRuntimeConfig(event)
  const isApi = await hasValidApiToken(event)
  const isZip = filename.endsWith('.zip')
  let maxBytes: number
  if (user && user.upload_max_bytes !== null) {
    maxBytes = user.upload_max_bytes
  } else if (isApi) {
    maxBytes = 100 * 1024 * 1024
  } else if (isZip) {
    maxBytes = 5 * 1024 * 1024
  } else {
    maxBytes = config.jolthost?.uploadMaxBytes ?? 25 * 1024 * 1024
  }
  const fileData = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data as ArrayBuffer)
  if (fileData.length > maxBytes) {
    throw createError({
      statusCode: 413,
      message: `File too large. Maximum size is ${Math.round(maxBytes / 1024 / 1024)}MB.`,
    })
  }

  if (!filename.endsWith('.html') && !filename.endsWith('.zip') && !filename.endsWith('.md')) {
    throw createError({ statusCode: 400, message: 'Only .html, .zip, or .md files are allowed' })
  }

  const slug = await generateUniqueSlug((s) => slugExists(event, s))
  const id = randomUUID()
  const ownerTokenBytes = crypto.getRandomValues(new Uint8Array(24))
  const ownerToken = toBase64Url(ownerTokenBytes)
  const bucket = useR2(event)

  let entryPoint: string

  if (filename.endsWith('.html')) {
    const key = `${slug}/index.html`
    await bucket.put(key, fileData, { httpMetadata: { contentType: 'text/html' } })
    entryPoint = key
  } else if (filename.endsWith('.md')) {
    const key = `${slug}/index.md`
    await bucket.put(key, fileData, { httpMetadata: { contentType: 'text/markdown' } })
    entryPoint = key
  } else {
    let files: Record<string, Uint8Array>
    try {
      files = unzipSync(fileData)
    } catch {
      throw createError({
        statusCode: 400,
        message: 'Invalid or corrupted ZIP file.',
      })
    }

    const filenames = Object.keys(files)
      .filter((name) => !name.endsWith('/')) // skip directories
      .map((name) => name.replace(/\\/g, '/').replace(/^\/+/, ''))

    // Upload each file to R2
    for (const name of filenames) {
      const contentType = mime.lookup(name) || 'application/octet-stream'
      await bucket.put(`${slug}/${name}`, files[name], { httpMetadata: { contentType } })
    }

    const htmlEntries = filenames
      .filter((name) => name.toLowerCase().endsWith('.html'))
      .sort((a, b) => {
        if (a.toLowerCase() === 'index.html') return -1
        if (b.toLowerCase() === 'index.html') return 1
        return a.localeCompare(b)
      })

    const entryFile = htmlEntries[0]
    if (!entryFile) {
      throw createError({ statusCode: 400, message: 'ZIP must contain at least one .html file' })
    }
    entryPoint = `${slug}/${entryFile}`
  }

  await insertUpload(event, id, slug, entryPoint, passwordHash, ownerToken, expiresAt, userId, title || null)

  const baseUrl = getRequestURL(event).origin
  const url = `${baseUrl}/view/${slug}`
  const response: Record<string, string> = {
    slug,
    url,
    entry_point: entryPoint,
    owner_token: ownerToken,
    url_with_owner_token: `${url}?owner_token=${encodeURIComponent(ownerToken)}`,
    expires_at: expiresAt ?? '',
    title: title || '',
  }
  if (password.length > 0) {
    const unlockToken = createUnlockToken(slug, expiresAt)
    response.url_with_unlock = `${url}?unlock=${encodeURIComponent(unlockToken)}`
  }
  return response
})
