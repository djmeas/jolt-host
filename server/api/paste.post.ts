import { getRequestIP, setResponseHeader } from 'h3'
import { randomUUID } from 'crypto'
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

  const body = await readBody<{ html?: string; expiration?: string; password?: string; title?: string; 'cf-turnstile-response'?: string }>(event)
  if (!(await hasValidApiToken(event))) {
    const turnstileToken = typeof body?.['cf-turnstile-response'] === 'string' ? body['cf-turnstile-response'].trim() : ''
    const turnstileOk = await verifyTurnstileToken(turnstileToken || undefined, ip)
    if (!turnstileOk) {
      throw createError({ statusCode: 400, message: 'Captcha verification failed. Please try again.' })
    }
  }

  const html = typeof body?.html === 'string' ? body.html.trim() : ''
  if (!html) {
    throw createError({ statusCode: 400, message: 'HTML content is required' })
  }

  const password = typeof body?.password === 'string' ? body.password.trim() : ''
  if (password.length > 200) {
    throw createError({ statusCode: 400, message: 'Password too long' })
  }
  const passwordHash = password.length > 0 ? await hashPassword(password) : null

  const expiration = typeof body?.expiration === 'string' ? body.expiration.trim() : ''
  let expiresAt = parseExpirationToISO(expiration)
  if (expiration && !expiresAt) {
    throw createError({ statusCode: 400, message: 'Invalid expiration value' })
  }

  const title = typeof body?.title === 'string' ? body.title.trim().slice(0, 100) : null

  const userId = getUserIdFromEvent(event) ?? null
  const user = userId ? await findUserById(event, userId) : null
  if (user && user.never_expire === 1) {
    expiresAt = null
  }

  const config = useRuntimeConfig(event)
  const maxBytes = config.jolthost?.uploadMaxBytes ?? 25 * 1024 * 1024
  const htmlBytes = new TextEncoder().encode(html).byteLength
  if (htmlBytes > maxBytes) {
    throw createError({
      statusCode: 413,
      message: `Content too large. Maximum size is ${Math.round(maxBytes / 1024 / 1024)}MB.`,
    })
  }

  const slug = await generateUniqueSlug((s) => slugExists(event, s))
  const id = randomUUID()
  const ownerTokenBytes = crypto.getRandomValues(new Uint8Array(24))
  const ownerToken = toBase64Url(ownerTokenBytes)

  const bucket = useR2(event)
  const entryPoint = `${slug}/index.html`
  await bucket.put(entryPoint, new TextEncoder().encode(html), {
    httpMetadata: { contentType: 'text/html' },
  })

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
