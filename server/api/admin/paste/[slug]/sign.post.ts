import { getRouterParam } from 'h3'
import { requireAdmin } from '~/server/utils/admin-auth'
import { findUploadBySlug } from '~/server/utils/db'
import { createUnlockToken } from '~/server/utils/view-auth'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const slug = getRouterParam(event, 'slug')
  if (!slug) {
    throw createError({ statusCode: 400, message: 'Missing slug' })
  }

  const row = await findUploadBySlug(event, slug)
  if (!row) {
    throw createError({ statusCode: 404, message: 'Upload not found' })
  }

  const unlockToken = createUnlockToken(slug, row.expires_at ?? null)
  const baseUrl = getRequestURL(event).origin
  const signedUrl = `${baseUrl}/view/${slug}?unlock=${encodeURIComponent(unlockToken)}`

  return { signedUrl }
})
