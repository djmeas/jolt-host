import { getRouterParam, readBody } from 'h3'
import { requireAdmin } from '~/server/utils/admin-auth'
import { findUploadBySlug, updateExpirationBySlug } from '~/server/utils/db'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const slug = getRouterParam(event, 'slug')
  if (!slug) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }
  const row = findUploadBySlug(slug)
  if (!row) {
    throw createError({ statusCode: 404, message: 'Upload not found' })
  }
  const body = await readBody(event).catch(() => ({}))
  const expiresAtRaw = body?.expiresAt

  let expiresAt: string | null = null
  if (typeof expiresAtRaw === 'string' && expiresAtRaw.trim()) {
    const date = new Date(expiresAtRaw)
    if (isNaN(date.getTime())) {
      throw createError({ statusCode: 400, message: 'Invalid date' })
    }
    expiresAt = date.toISOString()
  }

  updateExpirationBySlug(slug, expiresAt)
  return { ok: true }
})
