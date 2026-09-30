import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * Endpoint-level regression for the fail-closed ordering in POST /api/upload:
 * a deployment whose canonical hosted origin is unusable must answer 503
 * *before* writing any file or inserting an uploads row, so no orphaned site is
 * left behind without its owner token.
 */
const mocks = vi.hoisted(() => ({
  readMultipartFormData: vi.fn(),
  setResponseHeader: vi.fn(),
  getStorageDir: vi.fn(() => join(tmpdir(), 'jolt-upload-config-test')),
  insertUpload: vi.fn(),
  slugExists: vi.fn(() => false),
  findUserById: vi.fn(() => null),
  generateUniqueSlug: vi.fn(() => 'test-slug'),
  hashPassword: vi.fn(() => 'salt:key'),
  createUnlockToken: vi.fn(() => 'unlock-token'),
  checkUploadRateLimit: vi.fn(() => ({ allowed: true })),
  getClientIP: vi.fn(() => '127.0.0.1'),
  requireUploadAuthorization: vi.fn(),
  hasValidApiToken: vi.fn(() => true),
  resolveUploadUserId: vi.fn(() => null),
  verifyTurnstileToken: vi.fn(async () => true),
  writeUploadContent: vi.fn(async () => 'index.html'),
}))

vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('h3')>()
  return {
    ...actual,
    readMultipartFormData: mocks.readMultipartFormData,
    setResponseHeader: mocks.setResponseHeader,
  }
})

vi.mock('~/server/utils/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/utils/db')>()
  return {
    ...actual,
    getStorageDir: mocks.getStorageDir,
    insertUpload: mocks.insertUpload,
    slugExists: mocks.slugExists,
    findUserById: mocks.findUserById,
  }
})

vi.mock('~/server/utils/slug', () => ({ generateUniqueSlug: mocks.generateUniqueSlug }))
vi.mock('~/server/utils/password', () => ({ hashPassword: mocks.hashPassword }))
vi.mock('~/server/utils/view-auth', () => ({ createUnlockToken: mocks.createUnlockToken }))
vi.mock('~/server/utils/rate-limit', () => ({
  checkUploadRateLimit: mocks.checkUploadRateLimit,
  getClientIP: mocks.getClientIP,
}))
vi.mock('~/server/utils/upload-auth', () => ({
  requireUploadAuthorization: mocks.requireUploadAuthorization,
  hasValidApiToken: mocks.hasValidApiToken,
  resolveUploadUserId: mocks.resolveUploadUserId,
}))
vi.mock('~/server/utils/turnstile', () => ({ verifyTurnstileToken: mocks.verifyTurnstileToken }))
vi.mock('~/server/utils/upload-content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/utils/upload-content')>()
  return { ...actual, writeUploadContent: mocks.writeUploadContent }
})

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('useRuntimeConfig', () => ({ jolthost: { uploadMaxBytes: 25 * 1024 * 1024 } }))
// `createError` is a Nitro auto-import in application code, so the unit test has
// to provide the same error shape.
vi.stubGlobal('createError', (opts: { statusCode?: number; message?: string; statusMessage?: string }) =>
  Object.assign(new Error(opts.message ?? 'error'), opts)
)

function filePart() {
  return { name: 'file', filename: 'index.html', data: Buffer.from('<h1>hi</h1>') }
}

async function loadHandler() {
  const mod = await import('./upload.post')
  return mod.default as (event: unknown) => Promise<Record<string, string>>
}

/** Runs the handler with the environment restored afterwards. */
async function withEnv(
  env: Record<string, string>,
  run: () => Promise<void>
): Promise<void> {
  const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  try {
    await run()
  } finally {
    for (const [key, value] of previous) vi.stubEnv(key, value ?? '')
  }
}

describe('POST /api/upload canonical-origin guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.hasValidApiToken.mockReturnValue(true)
    mocks.generateUniqueSlug.mockReturnValue('test-slug')
    mocks.writeUploadContent.mockResolvedValue('index.html')
    mocks.checkUploadRateLimit.mockReturnValue({ allowed: true })
    mocks.readMultipartFormData.mockResolvedValue([filePart()])
  })

  it('publishes and returns the canonical hosted URL when the origin is configured', async () => {
    await withEnv(
      {
        NODE_ENV: 'test',
        JOLT_APP_ORIGIN: 'http://app.test',
        JOLT_SITE_BASE_ORIGIN: 'http://sites.test',
      },
      async () => {
        const handler = await loadHandler()
        const result = await handler({})
        expect(result.url).toBe('http://test-slug.sites.test/')
        expect(result.owner_token).toEqual(expect.any(String))
        expect(mocks.insertUpload).toHaveBeenCalledTimes(1)
      }
    )
  })

  it('returns 503 without writing files or inserting a row when the origin is unusable', async () => {
    await withEnv(
      {
        // Production requires HTTPS origins: an http pair is unusable, so the
        // request must fail closed before any persistent side effect.
        NODE_ENV: 'production',
        JOLT_APP_ORIGIN: 'http://host.example.com',
        JOLT_SITE_BASE_ORIGIN: 'http://sites.example.net',
      },
      async () => {
        const handler = await loadHandler()
        await expect(handler({})).rejects.toMatchObject({ statusCode: 503 })
        expect(mocks.writeUploadContent).not.toHaveBeenCalled()
        expect(mocks.insertUpload).not.toHaveBeenCalled()
      }
    )
  })

  it('returns 503 when the hosted origin is not configured at all', async () => {
    await withEnv(
      {
        NODE_ENV: 'production',
        JOLT_APP_ORIGIN: 'https://host.example.com',
        JOLT_SITE_BASE_ORIGIN: '',
      },
      async () => {
        const handler = await loadHandler()
        await expect(handler({})).rejects.toMatchObject({ statusCode: 503 })
        expect(mocks.writeUploadContent).not.toHaveBeenCalled()
        expect(mocks.insertUpload).not.toHaveBeenCalled()
      }
    )
  })
})
