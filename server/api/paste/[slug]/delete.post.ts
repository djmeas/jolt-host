import { getRouterParam, readBody } from 'h3'
import { findUploadBySlug, deleteUploadBySlugAndOwnerToken } from '~/server/utils/db'
import { deleteStorageForSlug } from '~/server/utils/storage'
import { deleteSiteData } from '~/server/utils/site-data'

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')
  if (!slug) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  const body = await readBody(event).catch(() => ({}))
  const ownerToken = typeof body?.owner_token === 'string' ? body.owner_token.trim() : ''
  if (!ownerToken) {
    throw createError({ statusCode: 400, message: 'Missing owner token' })
  }

  const row = findUploadBySlug(slug)
  if (!row) {
    throw createError({ statusCode: 404, message: 'Site not found' })
  }

  const deleted = deleteUploadBySlugAndOwnerToken(slug, ownerToken)
  if (!deleted) {
    throw createError({ statusCode: 403, message: 'Invalid owner token' })
  }

  deleteStorageForSlug(slug)
  deleteSiteData(row.id)

  return { ok: true }
})
