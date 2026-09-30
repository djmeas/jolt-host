import { getRouterParam } from 'h3'
import { requireAdmin } from '~/server/utils/admin-auth'
import { deleteUploadBySlug, findUploadBySlug } from '~/server/utils/db'
import { deleteStorageForSlug } from '~/server/utils/storage'
import { deleteSiteData } from '~/server/utils/site-data'

export default defineEventHandler((event) => {
  requireAdmin(event)
  const slug = getRouterParam(event, 'slug')
  if (!slug) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }
  const row = findUploadBySlug(slug)
  if (!row) {
    throw createError({ statusCode: 404, message: 'Paste not found' })
  }
  deleteStorageForSlug(slug)
  deleteUploadBySlug(slug)
  deleteSiteData(row.id)
  return { ok: true }
})
