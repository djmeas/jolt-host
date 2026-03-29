import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetExpiredUploadSlugs = vi.fn()
const mockDeleteUploadBySlug = vi.fn()
const mockDeleteStorageForSlug = vi.fn()

vi.mock('~/server/utils/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/utils/db')>()
  return {
    ...actual,
    getExpiredUploadSlugs: () => mockGetExpiredUploadSlugs(),
    deleteUploadBySlug: (slug: string) => mockDeleteUploadBySlug(slug),
  }
})

vi.mock('~/server/utils/storage', () => ({
  deleteStorageForSlug: (slug: string) => mockDeleteStorageForSlug(slug),
}))

// defineTask is a Nitro global — stub it so the module evaluates correctly in Vitest
vi.stubGlobal('defineTask', (def: unknown) => def)

describe('cleanup-expired task', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  async function loadTask() {
    const mod = await import('./cleanup-expired')
    return mod.default as { meta: { name: string; description: string }; run: () => { deleted: number; total: number } }
  }

  it('returns deleted=0 and total=0 when there are no expired slugs', async () => {
    mockGetExpiredUploadSlugs.mockReturnValue([])
    const task = await loadTask()

    const result = task.run()

    expect(result).toEqual({ deleted: 0, total: 0 })
    expect(mockDeleteStorageForSlug).not.toHaveBeenCalled()
    expect(mockDeleteUploadBySlug).not.toHaveBeenCalled()
  })

  it('deletes storage and db record for each expired slug', async () => {
    mockGetExpiredUploadSlugs.mockReturnValue(['slug-a', 'slug-b'])
    mockDeleteUploadBySlug.mockReturnValue(true)
    const task = await loadTask()

    const result = task.run()

    expect(result).toEqual({ deleted: 2, total: 2 })
    expect(mockDeleteStorageForSlug).toHaveBeenCalledWith('slug-a')
    expect(mockDeleteStorageForSlug).toHaveBeenCalledWith('slug-b')
    expect(mockDeleteUploadBySlug).toHaveBeenCalledWith('slug-a')
    expect(mockDeleteUploadBySlug).toHaveBeenCalledWith('slug-b')
  })

  it('deletes storage before the db record', async () => {
    const callOrder: string[] = []
    mockGetExpiredUploadSlugs.mockReturnValue(['slug-a'])
    mockDeleteStorageForSlug.mockImplementation(() => callOrder.push('storage'))
    mockDeleteUploadBySlug.mockImplementation(() => { callOrder.push('db'); return true })
    const task = await loadTask()

    task.run()

    expect(callOrder).toEqual(['storage', 'db'])
  })

  it('counts only slugs where deleteUploadBySlug returns true', async () => {
    mockGetExpiredUploadSlugs.mockReturnValue(['slug-a', 'slug-b', 'slug-c'])
    mockDeleteUploadBySlug
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
    const task = await loadTask()

    const result = task.run()

    expect(result).toEqual({ deleted: 2, total: 3 })
  })

  it('continues processing remaining slugs when one throws', async () => {
    mockGetExpiredUploadSlugs.mockReturnValue(['bad', 'good'])
    mockDeleteStorageForSlug.mockImplementationOnce(() => { throw new Error('EACCES') })
    mockDeleteUploadBySlug.mockReturnValue(true)
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const task = await loadTask()

    const result = task.run()

    // 'bad' threw so its db delete was never reached; 'good' succeeded
    expect(result.total).toBe(2)
    expect(result.deleted).toBe(1)
    expect(mockDeleteStorageForSlug).toHaveBeenCalledTimes(2)
    consoleSpy.mockRestore()
  })

  it('logs an error for the failing slug', async () => {
    mockGetExpiredUploadSlugs.mockReturnValue(['bad-slug'])
    mockDeleteStorageForSlug.mockImplementation(() => { throw new Error('disk full') })
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const task = await loadTask()

    task.run()

    expect(consoleSpy).toHaveBeenCalledOnce()
    expect(consoleSpy.mock.calls[0][0]).toContain('bad-slug')
    consoleSpy.mockRestore()
  })

  it('has the correct task name and a description', async () => {
    const task = await loadTask()

    expect(task.meta.name).toBe('cleanup-expired')
    expect(task.meta.description.length).toBeGreaterThan(0)
  })
})
