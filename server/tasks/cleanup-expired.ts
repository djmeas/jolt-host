import { getExpiredUploadSlugs, deleteUploadBySlug, getAllUploadEntryPoints } from '~/server/utils/db'
import { deleteStorageForSlug, pruneTrash, pruneStaging, reconcileContent } from '~/server/utils/storage'

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
    try {
      pruneTrash()
      pruneStaging()
      reconcileContent(getAllUploadEntryPoints())
    } catch (e) {
      console.error('[cleanup-expired] Failed to reconcile stored content:', e)
    }
    return { deleted, total: slugs.length }
  },
})
