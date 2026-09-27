import { rmSync, existsSync, mkdirSync, renameSync, readdirSync, statSync } from 'fs'
import { join, dirname, basename } from 'path'
import { randomUUID } from 'crypto'
import { getStorageDir } from '~/server/utils/db'

const CONTENT_ROOT = '.content'
const STAGING_ROOT = '.staging'
const TRASH_ROOT = '.trash'

/** How long retired/abandoned directories are kept before pruning, in ms. */
export const CONTENT_RETIRE_GRACE_MS = 5 * 60 * 1000

export function getContentRoot(): string {
  return join(getStorageDir(), CONTENT_ROOT)
}

export function getStagingRoot(): string {
  return join(getStorageDir(), STAGING_ROOT)
}

export function getTrashRoot(): string {
  return join(getStorageDir(), TRASH_ROOT)
}

/** Legacy per-slug directory used by existing uploads. */
export function getLegacySiteDir(slug: string): string {
  return join(getStorageDir(), slug)
}

/** Directory holding replacement content generations for a slug. */
export function getContentSlugDir(slug: string): string {
  return join(getContentRoot(), slug)
}

function removeDirIfExists(dir: string): void {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true })
  }
}

/** Deletes all stored files for a slug: legacy layout and replacement content. */
export function deleteStorageForSlug(slug: string): void {
  removeDirIfExists(getLegacySiteDir(slug))
  removeDirIfExists(getContentSlugDir(slug))
}

/** Creates a unique staging directory outside the served asset root. */
export function createStagingDir(id: string = randomUUID()): string {
  const dir = join(getStagingRoot(), id)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Atomically moves a staged directory into its permanent content location. */
export function publishStagedDir(stagingDir: string, slug: string, uniqueId: string): string {
  const dest = join(getContentSlugDir(slug), uniqueId)
  mkdirSync(dirname(dest), { recursive: true })
  renameSync(stagingDir, dest)
  return dest
}

/** Removes a directory that was created by a failed publication attempt. */
export function removeContentDir(dir: string): void {
  removeDirIfExists(dir)
}

/**
 * Moves retired content into the trash area so in-flight readers keep working.
 * If the move fails, the directory is removed instead.
 */
export function retireContentPath(dir: string): void {
  if (!existsSync(dir)) return
  const trash = getTrashRoot()
  mkdirSync(trash, { recursive: true })
  const dest = join(trash, `${Date.now()}-${basename(dir)}-${randomUUID().slice(0, 8)}`)
  try {
    renameSync(dir, dest)
  } catch {
    removeDirIfExists(dir)
  }
}

function isOlderThan(target: string, graceMs: number): boolean {
  try {
    return Date.now() - statSync(target).mtimeMs >= graceMs
  } catch {
    return false
  }
}

/** Deletes trash entries older than the grace period. */
export function pruneTrash(graceMs: number = CONTENT_RETIRE_GRACE_MS): void {
  const trash = getTrashRoot()
  if (!existsSync(trash)) return
  for (const name of readdirSync(trash)) {
    const target = join(trash, name)
    if (isOlderThan(target, graceMs)) removeDirIfExists(target)
  }
}

/** Deletes abandoned staging directories older than the grace period. */
export function pruneStaging(graceMs: number = CONTENT_RETIRE_GRACE_MS): void {
  const staging = getStagingRoot()
  if (!existsSync(staging)) return
  for (const name of readdirSync(staging)) {
    const target = join(staging, name)
    if (isOlderThan(target, graceMs)) removeDirIfExists(target)
  }
}

function entryDirForPoint(entryPoint: string): string {
  return dirname(join(getStorageDir(), entryPoint))
}

/**
 * Removes orphaned content without touching the live entry point. Only removes
 * directories older than the grace period so an in-progress update is safe.
 */
export function reconcileContent(
  rows: { slug: string; entry_point: string }[],
  graceMs: number = CONTENT_RETIRE_GRACE_MS
): void {
  const contentRoot = getContentRoot()
  const bySlug = new Map(rows.map((row) => [row.slug, row]))

  if (existsSync(contentRoot)) {
    for (const slug of readdirSync(contentRoot)) {
      const slugDir = join(contentRoot, slug)
      const row = bySlug.get(slug)
      if (!row) {
        if (isOlderThan(slugDir, graceMs)) removeDirIfExists(slugDir)
        continue
      }
      const currentDir = entryDirForPoint(row.entry_point)
      for (const child of readdirSync(slugDir)) {
        const childPath = join(slugDir, child)
        if (childPath === currentDir) continue
        if (isOlderThan(childPath, graceMs)) removeDirIfExists(childPath)
      }
    }
  }

  for (const row of rows) {
    const legacyDir = getLegacySiteDir(row.slug)
    if (!existsSync(legacyDir)) continue
    if (entryDirForPoint(row.entry_point) === legacyDir) continue
    if (isOlderThan(legacyDir, graceMs)) removeDirIfExists(legacyDir)
  }
}
