import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'crypto'
import type { UploadRow } from '~/server/utils/db'

const mockGetCookie = vi.fn()

vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('h3')>()
  return {
    ...actual,
    getCookie: (...args: unknown[]) => mockGetCookie(...args),
    createError: (opts: { statusCode?: number; message?: string }) => Object.assign(new Error(opts.message), opts),
  }
})

const mockFindUserById = vi.fn()
vi.mock('~/server/utils/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/utils/db')>()
  return {
    ...actual,
    findUserById: (id: string) => mockFindUserById(id),
  }
})

function userCookieValue(id: string): string {
  const expiry = String(Date.now() + 60_000)
  const secret = process.env.JOLT_USER_SECRET || process.env.JOLT_VIEW_SECRET || 'changeme'
  const sig = createHmac('sha256', secret).update(`user|${id}|${expiry}`).digest('base64url')
  return `${id}:${expiry}:${sig}`
}

function adminCookieValue(): string {
  const expiry = String(Date.now() + 60_000)
  const secret = process.env.JOLT_ADMIN_SECRET || process.env.JOLT_VIEW_SECRET || 'jolt-admin-default-change-in-production'
  const sig = createHmac('sha256', secret).update(`admin|${expiry}`).digest('base64url')
  return `${expiry}:${sig}`
}

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

async function load() {
  return await import('./update-auth')
}

describe('ownerTokenMatches', () => {
  it('matches identical tokens', async () => {
    const { ownerTokenMatches } = await load()
    expect(ownerTokenMatches('abc', 'abc')).toBe(true)
  })

  it('rejects different tokens and missing stored tokens', async () => {
    const { ownerTokenMatches } = await load()
    expect(ownerTokenMatches('abc', 'abd')).toBe(false)
    expect(ownerTokenMatches(null, 'abc')).toBe(false)
    expect(ownerTokenMatches('abc', '')).toBe(false)
  })
})

describe('authorizeContentUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('REGISTERED_USERS_ONLY', 'false')
    mockGetCookie.mockReturnValue(undefined)
  })
  afterEach(() => vi.unstubAllEnvs())

  it('authorizes an admin session', async () => {
    const { authorizeContentUpdate } = await load()
    mockGetCookie.mockImplementation((_e, name) => (name === 'jolt_admin' ? adminCookieValue() : undefined))
    expect(authorizeContentUpdate({} as any, row(), '')).toBe('admin')
  })

  it('open mode: authorizes a matching owner token without a session', async () => {
    const { authorizeContentUpdate } = await load()
    expect(authorizeContentUpdate({} as any, row(), 'owner-token')).toBe('owner_token')
  })

  it('open mode: authorizes the owning user', async () => {
    const { authorizeContentUpdate } = await load()
    mockGetCookie.mockImplementation((_e, name) => (name === 'jolt_user' ? userCookieValue('u1') : undefined))
    mockFindUserById.mockReturnValue({ id: 'u1' })
    expect(authorizeContentUpdate({} as any, row({ user_id: 'u1' }), '')).toBe('user')
  })

  it('open mode: rejects an unauthenticated request with no token', async () => {
    const { authorizeContentUpdate } = await load()
    expect(() => authorizeContentUpdate({} as any, row(), '')).toThrowError(/Owner token required/)
  })

  it('open mode: rejects a logged-in non-owner', async () => {
    const { authorizeContentUpdate } = await load()
    mockGetCookie.mockImplementation((_e, name) => (name === 'jolt_user' ? userCookieValue('u1') : undefined))
    mockFindUserById.mockReturnValue({ id: 'u1' })
    expect(() => authorizeContentUpdate({} as any, row({ user_id: 'someone-else' }), '')).toThrowError(/do not own/)
  })

  it('restricted mode: rejects an owner token without a login', async () => {
    vi.stubEnv('REGISTERED_USERS_ONLY', 'true')
    const { authorizeContentUpdate } = await load()
    expect(() => authorizeContentUpdate({} as any, row(), 'owner-token')).toThrowError(/Log in/)
  })

  it('restricted mode: login plus matching token authorizes an anonymous upload', async () => {
    vi.stubEnv('REGISTERED_USERS_ONLY', 'true')
    const { authorizeContentUpdate } = await load()
    mockGetCookie.mockImplementation((_e, name) => (name === 'jolt_user' ? userCookieValue('u1') : undefined))
    mockFindUserById.mockReturnValue({ id: 'u1' })
    expect(authorizeContentUpdate({} as any, row({ user_id: null }), 'owner-token')).toBe('owner_token')
  })

  it('restricted mode: owning user needs no token', async () => {
    vi.stubEnv('REGISTERED_USERS_ONLY', 'true')
    const { authorizeContentUpdate } = await load()
    mockGetCookie.mockImplementation((_e, name) => (name === 'jolt_user' ? userCookieValue('u1') : undefined))
    mockFindUserById.mockReturnValue({ id: 'u1' })
    expect(authorizeContentUpdate({} as any, row({ user_id: 'u1' }), '')).toBe('user')
  })

  it('restricted mode: admin still authorized without a user session', async () => {
    vi.stubEnv('REGISTERED_USERS_ONLY', 'true')
    const { authorizeContentUpdate } = await load()
    mockGetCookie.mockImplementation((_e, name) => (name === 'jolt_admin' ? adminCookieValue() : undefined))
    expect(authorizeContentUpdate({} as any, row({ user_id: 'someone' }), '')).toBe('admin')
  })
})
