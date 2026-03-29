import { readBody, getRouterParam } from 'h3'
import { requireUser } from '~/server/utils/user-auth'
import { findUploadBySlug, findUserById, updateExpirationBySlug } from '~/server/utils/db'

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

export default defineEventHandler(async (event) => {
  const userId = requireUser(event)
  const slug = getRouterParam(event, 'slug')
  if (!slug) {
    throw createError({ statusCode: 400, message: 'Slug is required' })
  }

  const upload = findUploadBySlug(slug)
  if (!upload) {
    throw createError({ statusCode: 404, message: 'Upload not found' })
  }

  if (upload.user_id !== userId) {
    throw createError({ statusCode: 403, message: 'Forbidden' })
  }

  const user = findUserById(userId)
  if (user && user.never_expire === 1) {
    throw createError({ statusCode: 403, message: 'Your account has never-expire enabled' })
  }

  const body = await readBody(event).catch(() => ({}))
  const expiresAtRaw = body?.expiresAt

  let expiresAt: string | null = null
  if (typeof expiresAtRaw === 'string' && expiresAtRaw.trim()) {
    expiresAt = parseExpirationToISO(expiresAtRaw.trim())
    if (!expiresAt) {
      throw createError({ statusCode: 400, message: 'Invalid expiration value' })
    }
  }

  updateExpirationBySlug(slug, expiresAt)

  return { ok: true }
})
