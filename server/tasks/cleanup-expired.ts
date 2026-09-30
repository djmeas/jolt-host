import {
  getExpiredUploadSlugs,
  deleteUploadBySlug,
  findUploadBySlug,
  getAllUploadEntryPoints,
  getAllUploadIds,
} from '~/server/utils/db'
import { deleteStorageForSlug, pruneTrash, pruneStaging, reconcileContent } from '~/server/utils/storage'
import { deleteSiteData, reconcileSiteData } from '~/server/utils/site-data'

export default defineTask({
  meta: {
    name: 'cleanup-expired',
    description: 'Delete expired static site uploads, their files, and their site data',
  },
  run() {
    const slugs = getExpiredUploadSlugs()
    let deleted = 0
    for (const slug of slugs) {
      const row = findUploadBySlug(slug)
      try {
        deleteStorageForSlug(slug)
        if (deleteUploadBySlug(slug)) deleted++
        // Only remove a site's database once its row is gone, so no request can
        // still be reading it.
        if (row) deleteSiteData(row.id)
      } catch (e) {
        console.error(`[cleanup-expired] Failed to delete slug ${slug}:`, e)
      }
    }
    try {
      pruneTrash()
      pruneStaging()
      reconcileContent(getAllUploadEntryPoints())
      reconcileSiteData(getAllUploadIds())
    } catch (e) {
      console.error('[cleanup-expired] Failed to reconcile stored content:', e)
    }
    return { deleted, total: slugs.length }
  },
})
