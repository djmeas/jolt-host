import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockExistsSync = vi.fn()
const mockRmSync = vi.fn()
const mockMkdirSync = vi.fn()
const mockRenameSync = vi.fn()
const mockReaddirSync = vi.fn()
const mockStatSync = vi.fn()
const mockGetStorageDir = vi.fn(() => '/fake/storage')

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    rmSync: (...args: unknown[]) => mockRmSync(...args),
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    renameSync: (...args: unknown[]) => mockRenameSync(...args),
    readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
    statSync: (...args: unknown[]) => mockStatSync(...args),
  }
})

vi.mock('~/server/utils/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/utils/db')>()
  return {
    ...actual,
    getStorageDir: () => mockGetStorageDir(),
  }
})

describe('storage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetStorageDir.mockReturnValue('/fake/storage')
    mockExistsSync.mockReturnValue(true)
  })

  async function load() {
    return await import('./storage')
  }

  describe('deleteStorageForSlug', () => {
    it('removes both the legacy directory and replacement content', async () => {
      const { deleteStorageForSlug } = await load()

      deleteStorageForSlug('abc123')

      expect(mockRmSync).toHaveBeenCalledWith('/fake/storage/abc123', { recursive: true })
      expect(mockRmSync).toHaveBeenCalledWith('/fake/storage/.content/abc123', { recursive: true })
    })

    it('does nothing when neither directory exists', async () => {
      const { deleteStorageForSlug } = await load()
      mockExistsSync.mockReturnValue(false)

      deleteStorageForSlug('abc123')

      expect(mockRmSync).not.toHaveBeenCalled()
    })
  })

  describe('createStagingDir', () => {
    it('creates a unique directory under the staging root', async () => {
      const { createStagingDir } = await load()

      const dir = createStagingDir('unique-id')

      expect(dir).toBe('/fake/storage/.staging/unique-id')
      expect(mockMkdirSync).toHaveBeenCalledWith('/fake/storage/.staging/unique-id', { recursive: true })
    })
  })

  describe('publishStagedDir', () => {
    it('renames the staged directory into the permanent content location', async () => {
      const { publishStagedDir } = await load()

      const dest = publishStagedDir('/fake/storage/.staging/u1', 'slug', 'u2')

      expect(dest).toBe('/fake/storage/.content/slug/u2')
      expect(mockRenameSync).toHaveBeenCalledWith('/fake/storage/.staging/u1', '/fake/storage/.content/slug/u2')
    })
  })

  describe('reconcileContent', () => {
    it('removes orphaned slug content but keeps the live entry directory', async () => {
      const { reconcileContent } = await load()
      // content root exists; slug dir has the live generation and a stale one.
      mockReaddirSync.mockImplementation((dir: string) => {
        if (dir === '/fake/storage/.content') return ['slug']
        if (dir === '/fake/storage/.content/slug') return ['keep', 'stale']
        return []
      })
      mockStatSync.mockReturnValue({ mtimeMs: 0 } as unknown as ReturnType<typeof import('fs').statSync>)

      reconcileContent([{ slug: 'slug', entry_point: '.content/slug/keep/index.html' }], 0)

      expect(mockRmSync).toHaveBeenCalledWith('/fake/storage/.content/slug/stale', { recursive: true })
      expect(mockRmSync).not.toHaveBeenCalledWith('/fake/storage/.content/slug/keep', { recursive: true })
    })

    it('removes content for slugs no longer in the database', async () => {
      const { reconcileContent } = await load()
      mockReaddirSync.mockImplementation((dir: string) => (dir === '/fake/storage/.content' ? ['orphan'] : []))
      mockStatSync.mockReturnValue({ mtimeMs: 0 } as unknown as ReturnType<typeof import('fs').statSync>)

      reconcileContent([], 0)

      expect(mockRmSync).toHaveBeenCalledWith('/fake/storage/.content/orphan', { recursive: true })
    })

    it('never removes a legacy directory that still holds the live entry point', async () => {
      const { reconcileContent } = await load()
      mockReaddirSync.mockReturnValue([])

      reconcileContent([{ slug: 'slug', entry_point: 'slug/index.html' }], 0)

      expect(mockRmSync).not.toHaveBeenCalledWith('/fake/storage/slug', { recursive: true })
    })
  })
})
