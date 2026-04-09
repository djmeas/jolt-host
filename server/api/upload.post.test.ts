import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readMultipartFormData: vi.fn(),
  getRequestIP: vi.fn(),
  setResponseHeader: vi.fn(),
  unzipSync: vi.fn(),
  mimeLookup: vi.fn(),
  isAuthorizedToUpload: vi.fn(),
  checkUploadRateLimit: vi.fn(),
  insertUpload: vi.fn(),
  slugExists: vi.fn(),
  generateUniqueSlug: vi.fn(),
  hashPassword: vi.fn(),
  createUnlockToken: vi.fn(),
  useR2: vi.fn(),
}))

vi.mock('h3', () => ({
  readMultipartFormData: mocks.readMultipartFormData,
  getRequestIP: mocks.getRequestIP,
  setResponseHeader: mocks.setResponseHeader,
}))

vi.mock('fflate', () => ({
  unzipSync: mocks.unzipSync,
}))

vi.mock('mime-types', () => ({
  default: { lookup: mocks.mimeLookup },
}))

vi.mock('~/server/utils/upload-auth', () => ({
  isAuthorizedToUpload: mocks.isAuthorizedToUpload,
}))

vi.mock('~/server/utils/rate-limit', () => ({
  checkUploadRateLimit: mocks.checkUploadRateLimit,
}))

vi.mock('~/server/utils/db', () => ({
  insertUpload: mocks.insertUpload,
  slugExists: mocks.slugExists,
}))

vi.mock('~/server/utils/slug', () => ({
  generateUniqueSlug: mocks.generateUniqueSlug,
}))

vi.mock('~/server/utils/password', () => ({
  hashPassword: mocks.hashPassword,
}))

vi.mock('~/server/utils/view-auth', () => ({
  createUnlockToken: mocks.createUnlockToken,
}))

vi.mock('~/server/utils/cf', () => ({
  useR2: mocks.useR2,
}))

describe('upload API', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.getRequestIP.mockReturnValue('127.0.0.1')
    mocks.isAuthorizedToUpload.mockResolvedValue(true)
    mocks.checkUploadRateLimit.mockReturnValue({ allowed: true, retryAfter: null })
    mocks.generateUniqueSlug.mockResolvedValue('test-slug')
    mocks.hashPassword.mockResolvedValue('hashed')
    mocks.createUnlockToken.mockReturnValue('unlock-token')
    mocks.insertUpload.mockResolvedValue(undefined)
    mocks.useR2.mockReturnValue({ put: vi.fn().mockResolvedValue(undefined) })
    mocks.readMultipartFormData.mockResolvedValue([
      {
        name: 'file',
        filename: 'index.html',
        data: new Uint8Array([65, 66, 67, 68, 69]),
      },
    ])

    ;(globalThis as typeof globalThis & {
      defineEventHandler: <T>(handler: T) => T
      getRequestURL: ReturnType<typeof vi.fn>
      useRuntimeConfig: ReturnType<typeof vi.fn>
      createError: (input: { statusCode: number; message: string; statusMessage?: string }) => Error & {
        statusCode: number
        message: string
      }
    }).defineEventHandler = <T>(
      handler: T
    ) => handler
    ;(globalThis as typeof globalThis & { getRequestURL: ReturnType<typeof vi.fn> }).getRequestURL = vi.fn(
      () => new URL('https://example.com')
    )
    ;(globalThis as typeof globalThis & { useRuntimeConfig: ReturnType<typeof vi.fn> }).useRuntimeConfig = vi.fn(
      (event?: unknown) => {
        if (event) {
          return { jolthost: { uploadMaxBytes: 10 } }
        }
        return { jolthost: { uploadMaxBytes: 1 } }
      }
    )
    ;(globalThis as typeof globalThis & {
      createError: (input: { statusCode: number; message: string; statusMessage?: string }) => Error & {
        statusCode: number
        message: string
      }
    }).createError = ({ statusCode, message }) => Object.assign(new Error(message), { statusCode, message })
  })

  it('uses request runtime config for upload size limit', async () => {
    const event = { context: { nitro: {} } }
    const handler = (await import('./upload.post')).default

    await expect(handler(event as never)).resolves.toMatchObject({
      slug: 'test-slug',
      entry_point: 'test-slug/index.html',
    })
    expect(globalThis.useRuntimeConfig).toHaveBeenCalledWith(event)
  })
})
