import { getExpiredUploadSlugs, deleteUploadBySlug } from '~/server/utils/db'
import { deleteStorageForSlug } from '~/server/utils/storage'

export default defineTask({
  meta: {
    name: 'cleanup-expired',
    description: 'Delete expired static site uploads from storage and database',
  },
  run() {
    const slugs = getExpiredUploadSlugs()
    let deleted = 0
    for (const slug of slugs) {
      try {
        deleteStorageForSlug(slug)
        if (deleteUploadBySlug(slug)) deleted++
      } catch (e) {
        console.error(`[cleanup-expired] Failed to delete slug ${slug}:`, e)
      }
    }
    return { deleted, total: slugs.length }
  },
})
