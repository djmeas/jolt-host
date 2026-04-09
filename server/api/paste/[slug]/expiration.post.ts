import { getRouterParam, readBody } from 'h3'
import { findUploadBySlug, updateExpirationBySlugAndOwnerToken } from '~/server/utils/db'

function parseExpirationToISO(value: string): string | null {
  if (!value) return null
  const now = Date.now()
  const match = value.match(/^(\d+)(h|w|d)$/i)
  if (!match) return null
  const n = parseInt(match[1], 10)
  const unit = match[2].toLowerCase()
  let ms = 0
  if (unit === 'h') ms = n * 60 * 60 * 1000
  else if (unit === 'd') ms = n * 24 * 60 * 60 * 1000
  else if (unit === 'w') ms = n * 7 * 24 * 60 * 60 * 1000
  else return null
  return new Date(now + ms).toISOString()
}

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')
  if (!slug) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }
  const body = await readBody(event).catch(() => ({}))
  const ownerToken = typeof body?.owner_token === 'string' ? body.owner_token.trim() : ''
  const expiration = typeof body?.expiration === 'string' ? body.expiration.trim() : ''
  if (!ownerToken) {
    throw createError({ statusCode: 400, message: 'Missing owner token' })
  }
  const row = await findUploadBySlug(event, slug)
  if (!row) {
    throw createError({ statusCode: 404, message: 'Paste not found' })
  }
  const expiresAt = parseExpirationToISO(expiration)
  if (expiration && expiresAt === null) {
    throw createError({ statusCode: 400, message: 'Invalid expiration value. Use 1h, 8h, 24h, 1w or empty for never.' })
  }
  const ok = await updateExpirationBySlugAndOwnerToken(event, slug, ownerToken, expiresAt)
  if (!ok) {
    throw createError({ statusCode: 403, message: 'Invalid owner token' })
  }
  return { ok: true, expires_at: expiresAt }
})
