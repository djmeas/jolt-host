import { requireAdmin } from '~/server/utils/admin-auth'
import { getExpiredUploadSlugs, deleteUploadBySlug } from '~/server/utils/db'
import { deleteStorageForSlug } from '~/server/utils/storage'

export default defineEventHandler(async (event) => {
  requireAdmin(event)

  const slugs = await getExpiredUploadSlugs(event)
  let deleted = 0
  for (const slug of slugs) {
    try {
      await deleteStorageForSlug(event, slug)
      if (await deleteUploadBySlug(event, slug)) deleted++
    } catch (e) {
      console.error(`[cleanup] Failed to delete slug ${slug}:`, e)
    }
  }
  return { deleted, total: slugs.length }
})
