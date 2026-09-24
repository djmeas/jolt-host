import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createWebSession } from './web-session'
import { createHmac } from 'crypto'

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
const mockFindUserById = vi.fn()
vi.mock('~/server/utils/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/utils/db')>()
  return {
    ...actual,
    findApiTokenByHash: (hash: string) => mockFindApiTokenByHash(hash),
    findUserById: (id: string) => mockFindUserById(id),
  }
})

describe('upload-auth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('REGISTERED_USERS_ONLY', 'false')
  })
  afterEach(() => vi.unstubAllEnvs())

  function userCookie(id: string): string {
    const expiry = String(Date.now() + 60_000)
    const secret = process.env.JOLT_USER_SECRET || process.env.JOLT_VIEW_SECRET || 'changeme'
    const sig = createHmac('sha256', secret).update(`user|${id}|${expiry}`).digest('base64url')
    return `${id}:${expiry}:${sig}`
  }

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

    it('requires an existing registered user when restricted, even with a web cookie or API token', async () => {
      vi.stubEnv('REGISTERED_USERS_ONLY', 'true')
      const { isAuthorizedToUpload } = await loadUploadAuth()
      const { value } = createWebSession()
      mockGetCookie.mockImplementation((_event, name) => name === 'jolt_web' ? value : undefined)
      mockGetRequestHeader.mockReturnValue('Bearer jolt_valid')
      mockFindApiTokenByHash.mockReturnValue({ id: '1' })
      expect(isAuthorizedToUpload(createMockEvent() as any)).toBe(false)

      mockGetCookie.mockImplementation((_event, name) => name === 'jolt_user' ? userCookie('deleted') : value)
      mockFindUserById.mockReturnValue(null)
      expect(isAuthorizedToUpload(createMockEvent() as any)).toBe(false)

      mockGetCookie.mockImplementation((_event, name) => name === 'jolt_user' ? userCookie('active') : value)
      mockFindUserById.mockReturnValue({ id: 'active' })
      expect(isAuthorizedToUpload(createMockEvent() as any)).toBe(true)
    })
  })
})
