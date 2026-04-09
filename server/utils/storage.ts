import type { H3Event } from 'h3'
import { useR2 } from '~/server/utils/cf'

/** Deletes all R2 objects for a slug (all files for that paste). */
export async function deleteStorageForSlug(event: H3Event, slug: string): Promise<void> {
  const bucket = useR2(event)
  let cursor: string | undefined

  // R2 list may be paginated; loop until all objects are deleted
  do {
    const listed = await bucket.list({ prefix: `${slug}/`, cursor })
    if (listed.objects.length > 0) {
      await bucket.delete(listed.objects.map((o) => o.key))
    }
    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor)
}
