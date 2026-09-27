import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { UploadRow } from '~/server/utils/db'

const mocks = vi.hoisted(() => ({
  getRouterParam: vi.fn(),
  readMultipartFormData: vi.fn(),
  setResponseHeader: vi.fn(),
  getRequestURL: vi.fn(() => new URL('http://host.test/api/uploads/slug/content')),
  findUploadBySlug: vi.fn(),
  findUserById: vi.fn(),
  updateEntryPointIfUnchanged: vi.fn(),
  createStagingDir: vi.fn(),
  publishStagedDir: vi.fn(),
  removeContentDir: vi.fn(),
  retireContentPath: vi.fn(),
  pruneStaging: vi.fn(),
  pruneTrash: vi.fn(),
  writeUploadContent: vi.fn(),
  authorizeContentUpdate: vi.fn(),
  checkUploadRateLimit: vi.fn(),
  getClientIP: vi.fn(() => '127.0.0.1'),
  hasValidApiToken: vi.fn(() => false),
  verifyTurnstileToken: vi.fn(async () => true),
  getUserIdFromEvent: vi.fn(() => null),
}))

function createError(opts: { statusCode?: number; message?: string; statusMessage?: string }) {
  return Object.assign(new Error(opts.message ?? 'error'), opts)
}

vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('h3')>()
  return {
    ...actual,
    getRouterParam: mocks.getRouterParam,
    readMultipartFormData: mocks.readMultipartFormData,
    setResponseHeader: mocks.setResponseHeader,
    getRequestURL: mocks.getRequestURL,
    createError,
  }
})

vi.mock('~/server/utils/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/utils/db')>()
  return {
    ...actual,
    getStorageDir: () => '/fake/storage',
    findUploadBySlug: mocks.findUploadBySlug,
    findUserById: mocks.findUserById,
    updateEntryPointIfUnchanged: mocks.updateEntryPointIfUnchanged,
  }
})

vi.mock('~/server/utils/storage', () => ({
  createStagingDir: mocks.createStagingDir,
  publishStagedDir: mocks.publishStagedDir,
  removeContentDir: mocks.removeContentDir,
  retireContentPath: mocks.retireContentPath,
  pruneStaging: mocks.pruneStaging,
  pruneTrash: mocks.pruneTrash,
}))

vi.mock('~/server/utils/upload-content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/utils/upload-content')>()
  return {
    ...actual,
    writeUploadContent: mocks.writeUploadContent,
  }
})

vi.mock('~/server/utils/update-auth', () => ({
  authorizeContentUpdate: mocks.authorizeContentUpdate,
}))

vi.mock('~/server/utils/rate-limit', () => ({
  checkUploadRateLimit: mocks.checkUploadRateLimit,
  getClientIP: mocks.getClientIP,
}))

vi.mock('~/server/utils/upload-auth', () => ({
  hasValidApiToken: mocks.hasValidApiToken,
}))

vi.mock('~/server/utils/turnstile', () => ({
  verifyTurnstileToken: mocks.verifyTurnstileToken,
}))

vi.mock('~/server/utils/user-auth', () => ({
  getUserIdFromEvent: mocks.getUserIdFromEvent,
}))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('useRuntimeConfig', () => ({ jolthost: { uploadMaxBytes: 25 * 1024 * 1024 } }))

function row(overrides: Partial<UploadRow> = {}): UploadRow {
  return {
    id: 'id',
    slug: 'slug',
    entry_point: 'slug/index.html',
    password_hash: null,
    owner_token: 'owner-token',
    created_at: '2026-01-01 00:00:00',
    expires_at: null,
    user_id: null,
    title: null,
    ...overrides,
  }
}

function filePart(data = Buffer.from('<h1>hi</h1>'), filename = 'index.html') {
  return { name: 'file', filename, data }
}

async function loadHandler() {
  const mod = await import('./content.put')
  return mod.default as (event: unknown) => Promise<Record<string, unknown>>
}

describe('PUT /api/uploads/[slug]/content handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getRouterParam.mockReturnValue('slug')
    mocks.getRequestURL.mockReturnValue(new URL('http://host.test/api/uploads/slug/content'))
    mocks.checkUploadRateLimit.mockReturnValue({ allowed: true })
    mocks.hasValidApiToken.mockReturnValue(false)
    mocks.verifyTurnstileToken.mockResolvedValue(true)
    mocks.getUserIdFromEvent.mockReturnValue(null)
    mocks.findUserById.mockReturnValue(null)
    mocks.findUploadBySlug.mockReturnValue(row())
    mocks.authorizeContentUpdate.mockReturnValue('owner_token')
    mocks.createStagingDir.mockReturnValue('/fake/storage/.staging/u1')
    mocks.publishStagedDir.mockReturnValue('/fake/storage/.content/slug/u2')
    mocks.writeUploadContent.mockResolvedValue('index.html')
    mocks.updateEntryPointIfUnchanged.mockReturnValue(true)
    mocks.readMultipartFormData.mockResolvedValue([filePart()])
    mocks.findUploadBySlug.mockReturnValue(row())
  })

  it('publishes a valid replacement and returns slug, url, and entry_point', async () => {
    const handler = await loadHandler()
    const result = await handler({})

    expect(result).toEqual({
      slug: 'slug',
      url: 'http://host.test/view/slug',
      entry_point: '.content/slug/u2/index.html',
    })
    expect(result).not.toHaveProperty('owner_token')
    expect(mocks.writeUploadContent).toHaveBeenCalled()
    expect(mocks.updateEntryPointIfUnchanged).toHaveBeenCalledWith('slug', 'slug/index.html', '.content/slug/u2/index.html')
    expect(mocks.retireContentPath).toHaveBeenCalledWith('/fake/storage/slug')
  })

  it('returns 404 when the site does not exist', async () => {
    mocks.findUploadBySlug.mockReturnValueOnce(undefined)
    const handler = await loadHandler()
    await expect(handler({})).rejects.toMatchObject({ statusCode: 404 })
  })

  it('returns 404 for an expired site without staging anything', async () => {
    mocks.findUploadBySlug.mockReturnValueOnce(row({ expires_at: '2000-01-01T00:00:00.000Z' }))
    const handler = await loadHandler()
    await expect(handler({})).rejects.toMatchObject({ statusCode: 404 })
    expect(mocks.createStagingDir).not.toHaveBeenCalled()
  })

  it('returns 429 when the rate limit is exceeded', async () => {
    mocks.checkUploadRateLimit.mockReturnValue({ allowed: false, retryAfter: 42 })
    const handler = await loadHandler()
    await expect(handler({})).rejects.toMatchObject({ statusCode: 429 })
    expect(mocks.readMultipartFormData).not.toHaveBeenCalled()
  })

  it('returns 400 when no file is present', async () => {
    mocks.readMultipartFormData.mockResolvedValue([{ name: 'owner_token', data: Buffer.from('t') }])
    const handler = await loadHandler()
    await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
  })

  it('returns 400 for an unsupported extension', async () => {
    mocks.readMultipartFormData.mockResolvedValue([filePart(Buffer.from('x'), 'evil.exe')])
    const handler = await loadHandler()
    await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
  })

  it('returns 413 when the file exceeds the limit', async () => {
    mocks.readMultipartFormData.mockResolvedValue([filePart(Buffer.alloc(26 * 1024 * 1024), 'big.html')])
    const handler = await loadHandler()
    await expect(handler({})).rejects.toMatchObject({ statusCode: 413 })
    expect(mocks.writeUploadContent).not.toHaveBeenCalled()
  })

  it('returns 400 when CAPTCHA verification fails and no API token is present', async () => {
    mocks.verifyTurnstileToken.mockResolvedValue(false)
    const handler = await loadHandler()
    await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
  })

  it('skips CAPTCHA when a valid API token is present', async () => {
    mocks.hasValidApiToken.mockReturnValue(true)
    const handler = await loadHandler()
    await handler({})
    expect(mocks.verifyTurnstileToken).not.toHaveBeenCalled()
  })

  it('propagates an authorization failure before staging any files', async () => {
    mocks.authorizeContentUpdate.mockImplementation(() => {
      throw createError({ statusCode: 403, message: 'nope' })
    })
    const handler = await loadHandler()
    await expect(handler({})).rejects.toMatchObject({ statusCode: 403 })
    expect(mocks.createStagingDir).not.toHaveBeenCalled()
    expect(mocks.writeUploadContent).not.toHaveBeenCalled()
  })

  it('cleans up staged files and keeps the site intact when preparation fails', async () => {
    mocks.writeUploadContent.mockRejectedValue(createError({ statusCode: 400, message: 'bad zip' }))
    const handler = await loadHandler()
    await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
    expect(mocks.removeContentDir).toHaveBeenCalledWith('/fake/storage/.staging/u1')
    expect(mocks.updateEntryPointIfUnchanged).not.toHaveBeenCalled()
  })

  it('returns 409 and removes new files when the entry point changed concurrently', async () => {
    mocks.updateEntryPointIfUnchanged.mockReturnValue(false)
    mocks.findUploadBySlug
      .mockReturnValueOnce(row())
      .mockReturnValueOnce(row({ entry_point: '.content/slug/other/index.html' }))
    const handler = await loadHandler()
    await expect(handler({})).rejects.toMatchObject({ statusCode: 409 })
    expect(mocks.removeContentDir).toHaveBeenCalledWith('/fake/storage/.content/slug/u2')
    expect(mocks.retireContentPath).not.toHaveBeenCalled()
  })

  it('returns 404 when a concurrent request removed the site', async () => {
    mocks.updateEntryPointIfUnchanged.mockReturnValue(false)
    mocks.findUploadBySlug.mockReturnValueOnce(row()).mockReturnValueOnce(undefined)
    const handler = await loadHandler()
    await expect(handler({})).rejects.toMatchObject({ statusCode: 404 })
    expect(mocks.removeContentDir).toHaveBeenCalledWith('/fake/storage/.content/slug/u2')
  })

  it('does not retire the storage root', async () => {
    mocks.findUploadBySlug.mockReturnValue(row({ entry_point: 'index.html' }))
    const handler = await loadHandler()
    await handler({})
    expect(mocks.retireContentPath).not.toHaveBeenCalled()
  })
})
