import { rmSync, existsSync } from 'fs'
import { join } from 'path'
import { getStorageDir } from '~/server/utils/db'

/** Deletes the storage directory for a slug (all files for that paste). */
export function deleteStorageForSlug(slug: string): void {
  const storage = getStorageDir()
  const dir = join(storage, slug)
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true })
  }
}
