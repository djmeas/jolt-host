import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockExistsSync = vi.fn()
const mockRmSync = vi.fn()
const mockGetStorageDir = vi.fn(() => '/fake/storage')

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    rmSync: (...args: unknown[]) => mockRmSync(...args),
  }
})

vi.mock('~/server/utils/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/utils/db')>()
  return {
    ...actual,
    getStorageDir: () => mockGetStorageDir(),
  }
})

describe('deleteStorageForSlug', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetStorageDir.mockReturnValue('/fake/storage')
  })

  async function load() {
    const { deleteStorageForSlug } = await import('./storage')
    return deleteStorageForSlug
  }

  it('removes the directory when it exists', async () => {
    mockExistsSync.mockReturnValue(true)
    const deleteStorageForSlug = await load()

    deleteStorageForSlug('abc123')

    expect(mockRmSync).toHaveBeenCalledWith('/fake/storage/abc123', { recursive: true })
  })

  it('does nothing when the directory does not exist', async () => {
    mockExistsSync.mockReturnValue(false)
    const deleteStorageForSlug = await load()

    deleteStorageForSlug('abc123')

    expect(mockRmSync).not.toHaveBeenCalled()
  })

  it('checks the correct path for the given slug', async () => {
    mockExistsSync.mockReturnValue(true)
    const deleteStorageForSlug = await load()

    deleteStorageForSlug('my-slug')

    expect(mockExistsSync).toHaveBeenCalledWith('/fake/storage/my-slug')
    expect(mockRmSync).toHaveBeenCalledWith('/fake/storage/my-slug', { recursive: true })
  })

  it('uses the path returned by getStorageDir', async () => {
    mockGetStorageDir.mockReturnValue('/custom/path')
    mockExistsSync.mockReturnValue(true)
    const deleteStorageForSlug = await load()

    deleteStorageForSlug('slug-x')

    expect(mockRmSync).toHaveBeenCalledWith('/custom/path/slug-x', { recursive: true })
  })
})
