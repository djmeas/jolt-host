import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash, createHmac } from 'crypto'
import type { UploadRow } from '~/server/utils/db'

const cookies = new Map<string, { value: string; options: Record<string, unknown> }>()

vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('h3')>()
  return {
    ...actual,
    getCookie: (_event: unknown, name: string) => cookies.get(name)?.value,
    setCookie: (_event: unknown, name: string, value: string, options: Record<string, unknown>) => {
      cookies.set(name, { value, options })
    },
    deleteCookie: (_event: unknown, name: string) => {
      cookies.delete(name)
    },
  }
})

const SECRET = 'test-data-session-secret-value'

function row(overrides: Partial<UploadRow> = {}): UploadRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    slug: 'quick-dragon-42',
    entry_point: 'quick-dragon-42/index.html',
    password_hash: 'salt:key',
    owner_token: 'owner-token',
    created_at: '2026-01-01 00:00:00',
    expires_at: null,
    user_id: null,
    title: null,
    data_enabled: 1,
    ...overrides,
  }
}

async function load() {
  // Dynamic import: the mocked h3 module must be in place before this loads.
  return await import('./data-auth')
}

/** Builds a structurally valid cookie so tests exercise the intended check. */
function signedCookie(expiry: number, passwordHash = 'salt:key'): string {
  const siteId = row().id
  const version = createHash('sha256').update(passwordHash, 'utf8').digest('base64url').slice(0, 22)
  const sig = createHmac('sha256', SECRET)
    .update(`data|${siteId}|${expiry}|${version}`)
    .digest('base64url')
  return `${siteId}:${expiry}:${sig}`
}

beforeEach(() => {
  cookies.clear()
  vi.stubEnv('JOLT_APP_ORIGIN', 'http://app.test')
  vi.stubEnv('JOLT_SITE_BASE_ORIGIN', 'http://sites.test')
  vi.stubEnv('JOLT_DATA_SESSION_SECRET', SECRET)
  vi.stubEnv('JOLT_VIEW_SECRET', 'a-strong-view-secret-value')
})

afterEach(() => vi.unstubAllEnvs())

describe('data feature status', () => {
  it('is enabled with hosted origins and a session secret', async () => {
    const { getDataFeatureStatus } = await load()
    expect(getDataFeatureStatus()).toEqual({ enabled: true, reason: null })
  })

  it('is disabled without a session secret', async () => {
    vi.stubEnv('JOLT_DATA_SESSION_SECRET', '')
    const { getDataFeatureStatus } = await load()
    expect(getDataFeatureStatus().enabled).toBe(false)
  })

  it('is disabled under production with a default view secret or short secrets', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('JOLT_APP_ORIGIN', 'https://host.example.com')
    vi.stubEnv('JOLT_SITE_BASE_ORIGIN', 'https://sites.example.net')
    vi.stubEnv('JOLT_VIEW_SECRET', 'jolt-view-default-change-in-production')
    const { getDataFeatureStatus } = await load()
    expect(getDataFeatureStatus().enabled).toBe(false)
  })
})

describe('data-admin cookie', () => {
  it('issues a host-only, HttpOnly, strict cookie scoped to the data API', async () => {
    const { setDataSessionCookie } = await load()
    expect(setDataSessionCookie({} as never, row())).toBe(true)

    const stored = cookies.get('jolt_data')
    expect(stored).toBeDefined()
    expect(stored!.options).toMatchObject({
      path: '/_jolt/data',
      httpOnly: true,
      sameSite: 'strict',
    })
    expect(stored!.options.Domain).toBeUndefined()
  })

  it('accepts its own cookie for the matching row', async () => {
    const { setDataSessionCookie, hasValidDataSession } = await load()
    setDataSessionCookie({} as never, row())
    expect(hasValidDataSession({} as never, row())).toBe(true)
  })

  it('rejects a cookie issued for another site', async () => {
    const { setDataSessionCookie, hasValidDataSession } = await load()
    setDataSessionCookie({} as never, row())
    const other = row({ id: '22222222-2222-4222-8222-222222222222' })
    expect(hasValidDataSession({} as never, other)).toBe(false)
  })

  it('rejects the cookie as soon as the password changes', async () => {
    const { setDataSessionCookie, hasValidDataSession } = await load()
    setDataSessionCookie({} as never, row())
    expect(hasValidDataSession({} as never, row({ password_hash: 'new-salt:new-key' }))).toBe(false)
  })

  it('rejects the cookie when data is disabled or the password is cleared', async () => {
    const { setDataSessionCookie, hasValidDataSession } = await load()
    setDataSessionCookie({} as never, row())
    expect(hasValidDataSession({} as never, row({ data_enabled: 0 }))).toBe(false)
    expect(hasValidDataSession({} as never, row({ password_hash: null }))).toBe(false)
  })

  it('refuses to issue a cookie for a site that cannot hold one', async () => {
    const { setDataSessionCookie } = await load()
    expect(setDataSessionCookie({} as never, row({ password_hash: null }))).toBe(false)
    expect(setDataSessionCookie({} as never, row({ data_enabled: 0 }))).toBe(false)
    expect(cookies.has('jolt_data')).toBe(false)
  })

  it('rejects an expired cookie', async () => {
    const { hasValidDataSession } = await load()
    cookies.set('jolt_data', {
      value: signedCookie(Date.now() - 1000),
      options: {},
    })
    expect(hasValidDataSession({} as never, row())).toBe(false)
  })

  it('accepts a correctly signed cookie (control for the rejection tests)', async () => {
    const { hasValidDataSession } = await load()
    cookies.set('jolt_data', { value: signedCookie(Date.now() + 60_000), options: {} })
    expect(hasValidDataSession({} as never, row())).toBe(true)
  })

  it('rejects a cookie signed with a different password hash', async () => {
    const { hasValidDataSession } = await load()
    cookies.set('jolt_data', {
      value: signedCookie(Date.now() + 60_000, 'old-salt:old-key'),
      options: {},
    })
    expect(hasValidDataSession({} as never, row())).toBe(false)
  })

  it('rejects a forged signature and a malformed value', async () => {
    const { hasValidDataSession } = await load()
    cookies.set('jolt_data', { value: `${row().id}:${Date.now() + 60_000}:not-a-signature`, options: {} })
    expect(hasValidDataSession({} as never, row())).toBe(false)
    cookies.set('jolt_data', { value: 'garbage', options: {} })
    expect(hasValidDataSession({} as never, row())).toBe(false)
  })

  it('rejects every cookie when no session secret is configured', async () => {
    const { setDataSessionCookie, hasValidDataSession } = await load()
    setDataSessionCookie({} as never, row())
    vi.stubEnv('JOLT_DATA_SESSION_SECRET', '')
    expect(hasValidDataSession({} as never, row())).toBe(false)
  })

  it('clears the cookie', async () => {
    const { setDataSessionCookie, clearDataSessionCookie } = await load()
    setDataSessionCookie({} as never, row())
    clearDataSessionCookie({} as never)
    expect(cookies.has('jolt_data')).toBe(false)
  })

  it('derives a stable, non-cookie session key for write limits', async () => {
    const { setDataSessionCookie, getDataSessionKey } = await load()
    setDataSessionCookie({} as never, row())
    const key = getDataSessionKey({} as never)
    expect(key).toMatch(/^[0-9a-f]{16}$/)
    expect(key).toBe(getDataSessionKey({} as never))
    expect(key).not.toContain(':')
  })
})
