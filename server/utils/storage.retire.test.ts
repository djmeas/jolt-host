import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, rmSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let storageDir: string

vi.mock('~/server/utils/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/utils/db')>()
  return {
    ...actual,
    getStorageDir: () => storageDir,
  }
})

async function load() {
  return await import('./storage')
}

/** Backdates a path so it is older than any grace period under test. */
function age(target: string, ms: number) {
  const seconds = (Date.now() - ms) / 1000
  utimesSync(target, seconds, seconds)
}

describe('storage retire / prune / reconcile (filesystem)', () => {
  beforeEach(() => {
    storageDir = mkdtempSync(join(tmpdir(), 'jolt-storage-'))
  })

  afterEach(() => {
    rmSync(storageDir, { recursive: true, force: true })
  })

  describe('retireContentPath', () => {
    it('moves a directory into the trash area', async () => {
      const { retireContentPath, getTrashRoot } = await load()
      const dir = join(storageDir, 'legacy-slug')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'index.html'), 'hi')

      retireContentPath(dir)

      expect(existsSync(dir)).toBe(false)
      const trashed = readdirSync(getTrashRoot())
      expect(trashed).toHaveLength(1)
      expect(existsSync(join(getTrashRoot(), trashed[0]!, 'index.html'))).toBe(true)
    })

    it('does nothing when the path is already gone', async () => {
      const { retireContentPath, getTrashRoot } = await load()

      retireContentPath(join(storageDir, 'missing'))

      expect(existsSync(getTrashRoot())).toBe(false)
    })
  })

  describe('pruneTrash', () => {
    it('removes only entries older than the grace period', async () => {
      const { pruneTrash, getTrashRoot } = await load()
      const trash = getTrashRoot()
      const old = join(trash, 'old')
      const recent = join(trash, 'recent')
      mkdirSync(old, { recursive: true })
      mkdirSync(recent, { recursive: true })
      age(old, 10 * 60 * 1000)

      pruneTrash(5 * 60 * 1000)

      expect(existsSync(old)).toBe(false)
      expect(existsSync(recent)).toBe(true)
    })

    it('is a no-op when the trash area does not exist', async () => {
      const { pruneTrash } = await load()
      expect(() => pruneTrash()).not.toThrow()
    })
  })

  describe('pruneStaging', () => {
    it('removes abandoned staging directories older than the grace period', async () => {
      const { pruneStaging, getStagingRoot } = await load()
      const staging = getStagingRoot()
      const old = join(staging, 'old')
      const recent = join(staging, 'recent')
      mkdirSync(old, { recursive: true })
      mkdirSync(recent, { recursive: true })
      age(old, 10 * 60 * 1000)

      pruneStaging(5 * 60 * 1000)

      expect(existsSync(old)).toBe(false)
      expect(existsSync(recent)).toBe(true)
    })
  })

  describe('reconcileContent', () => {
    it('keeps the live generation and removes stale ones', async () => {
      const { reconcileContent, getContentSlugDir } = await load()
      const slugDir = getContentSlugDir('slug')
      mkdirSync(join(slugDir, 'live'), { recursive: true })
      mkdirSync(join(slugDir, 'stale'), { recursive: true })
      writeFileSync(join(slugDir, 'live', 'index.html'), 'live')
      age(join(slugDir, 'stale'), 10 * 60 * 1000)

      reconcileContent([{ slug: 'slug', entry_point: '.content/slug/live/index.html' }], 5 * 60 * 1000)

      expect(existsSync(join(slugDir, 'live', 'index.html'))).toBe(true)
      expect(existsSync(join(slugDir, 'stale'))).toBe(false)
    })

    it('removes content for slugs no longer in the database', async () => {
      const { reconcileContent, getContentSlugDir } = await load()
      const orphan = getContentSlugDir('orphan')
      mkdirSync(orphan, { recursive: true })
      age(orphan, 10 * 60 * 1000)

      reconcileContent([], 5 * 60 * 1000)

      expect(existsSync(orphan)).toBe(false)
    })

    it('keeps the legacy directory when it still holds the live entry point', async () => {
      const { reconcileContent, getLegacySiteDir } = await load()
      const legacy = getLegacySiteDir('slug')
      mkdirSync(legacy, { recursive: true })
      writeFileSync(join(legacy, 'index.html'), 'live')
      age(legacy, 10 * 60 * 1000)

      reconcileContent([{ slug: 'slug', entry_point: 'slug/index.html' }], 5 * 60 * 1000)

      expect(existsSync(join(legacy, 'index.html'))).toBe(true)
    })

    it('removes a legacy directory after the entry point moved to replacement content', async () => {
      const { reconcileContent, getLegacySiteDir } = await load()
      const legacy = getLegacySiteDir('slug')
      mkdirSync(legacy, { recursive: true })
      writeFileSync(join(legacy, 'index.html'), 'old')
      age(legacy, 10 * 60 * 1000)

      reconcileContent([{ slug: 'slug', entry_point: '.content/slug/gen/index.html' }], 5 * 60 * 1000)

      expect(existsSync(legacy)).toBe(false)
    })
  })
})
