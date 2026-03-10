import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createWebSession } from './web-session'

const mockGetRequestHeader = vi.fn()
const mockGetCookie = vi.fn()

vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('h3')>()
  return {
    ...actual,
    getRequestHeader: (...args: unknown[]) => mockGetRequestHeader(...args),
    getCookie: (...args: unknown[]) => mockGetCookie(...args),
  }
})

const mockFindApiTokenByHash = vi.fn()
vi.mock('~/server/utils/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/utils/db')>()
  return {
    ...actual,
    findApiTokenByHash: (hash: string) => mockFindApiTokenByHash(hash),
  }
})

describe('upload-auth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  async function loadUploadAuth() {
    const { hasValidApiToken, isAuthorizedToUpload } = await import('./upload-auth')
    return { hasValidApiToken, isAuthorizedToUpload }
  }

  const createMockEvent = () => ({})

  describe('hasValidApiToken', () => {
    it('returns false when no Authorization header', async () => {
      const { hasValidApiToken } = await loadUploadAuth()
      mockGetRequestHeader.mockReturnValue(undefined)
      expect(hasValidApiToken(createMockEvent() as any)).toBe(false)
    })

    it('returns false when Authorization is not Bearer', async () => {
      const { hasValidApiToken } = await loadUploadAuth()
      mockGetRequestHeader.mockReturnValue('Basic xxx')
      expect(hasValidApiToken(createMockEvent() as any)).toBe(false)
    })

    it('returns false when token does not start with jolt_', async () => {
      const { hasValidApiToken } = await loadUploadAuth()
      mockGetRequestHeader.mockReturnValue('Bearer invalid_token')
      mockFindApiTokenByHash.mockReturnValue(undefined)
      expect(hasValidApiToken(createMockEvent() as any)).toBe(false)
    })

    it('returns false when token is not in database', async () => {
      const { hasValidApiToken } = await loadUploadAuth()
      mockGetRequestHeader.mockReturnValue('Bearer jolt_abc123validformat')
      mockFindApiTokenByHash.mockReturnValue(undefined)
      expect(hasValidApiToken(createMockEvent() as any)).toBe(false)
    })

    it('returns true when valid token in database', async () => {
      const { hasValidApiToken } = await loadUploadAuth()
      mockGetRequestHeader.mockReturnValue('Bearer jolt_abc123validformat')
      mockFindApiTokenByHash.mockReturnValue({ id: '1', nickname: 'test' })
      expect(hasValidApiToken(createMockEvent() as any)).toBe(true)
    })

    it('accepts Bearer with varying casing', async () => {
      const { hasValidApiToken } = await loadUploadAuth()
      mockGetRequestHeader.mockReturnValue('bearer jolt_abc123')
      mockFindApiTokenByHash.mockReturnValue({ id: '1' })
      expect(hasValidApiToken(createMockEvent() as any)).toBe(true)
    })
  })

  describe('isAuthorizedToUpload', () => {
    it('returns true when valid API token', async () => {
      const { isAuthorizedToUpload } = await loadUploadAuth()
      mockGetRequestHeader.mockReturnValue('Bearer jolt_valid')
      mockFindApiTokenByHash.mockReturnValue({ id: '1' })
      expect(isAuthorizedToUpload(createMockEvent() as any)).toBe(true)
    })

    it('returns true when valid web session cookie', async () => {
      const { isAuthorizedToUpload } = await loadUploadAuth()
      mockGetRequestHeader.mockReturnValue(undefined)
      const { value } = createWebSession()
      mockGetCookie.mockReturnValue(value)
      expect(isAuthorizedToUpload(createMockEvent() as any)).toBe(true)
    })

    it('returns false when neither token nor web session', async () => {
      const { isAuthorizedToUpload } = await loadUploadAuth()
      mockGetRequestHeader.mockReturnValue(undefined)
      mockGetCookie.mockReturnValue(undefined)
      mockFindApiTokenByHash.mockReturnValue(undefined)
      expect(isAuthorizedToUpload(createMockEvent() as any)).toBe(false)
    })
  })
})
