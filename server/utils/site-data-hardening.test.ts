import { describe, it, expect, afterEach, afterAll, vi } from 'vitest'
import { randomUUID } from 'crypto'
import {
  deleteUploadBySlug,
  disableDataBySlug,
  enableDataBySlug,
  findUploadBySlug,
  insertUpload,
} from './db'
import type { UploadRow } from './db'
import { requireDataEnabled } from './data-api'
import { checkDataRequestRate, resetSiteRateLimits } from './site-rate-limit'
import { isAppOriginHost, isSiteBaseHost } from './site-host'

const createdSlugs: string[] = []

function insertRow(overrides: { passwordHash?: string | null; expiresAt?: string | null } = {}): string {
  const slug = `guard-${randomUUID().slice(0, 8)}`
  insertUpload(
    randomUUID(),
    slug,
    `${slug}/index.html`,
    overrides.passwordHash === undefined ? 'salt:key' : overrides.passwordHash,
    'owner-token',
    overrides.expiresAt ?? null,
    null,
    null
  )
  createdSlugs.push(slug)
  return slug
}

function row(overrides: Partial<UploadRow> = {}): UploadRow {
  return {
    id: randomUUID(),
    slug: 'slug',
    entry_point: 'slug/index.html',
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

afterEach(() => {
  vi.unstubAllEnvs()
  resetSiteRateLimits()
})

afterAll(() => {
  for (const slug of createdSlugs) deleteUploadBySlug(slug)
})

describe('data enablement predicate', () => {
  it('enables data for a password-protected, unexpired site', () => {
    const slug = insertRow()
    try {
      expect(enableDataBySlug(slug)).toBe(true)
      expect(findUploadBySlug(slug)?.data_enabled).toBe(1)
      // Re-enabling an already-enabled site still reports success.
      expect(enableDataBySlug(slug)).toBe(true)
    } finally {
      deleteUploadBySlug(slug)
    }
  })

  it('refuses to enable data without a password', () => {
    const slug = insertRow({ passwordHash: null })
    try {
      expect(enableDataBySlug(slug)).toBe(false)
      expect(findUploadBySlug(slug)?.data_enabled).toBe(0)
    } finally {
      deleteUploadBySlug(slug)
    }
  })

  it('refuses to enable data on an expired or missing row', () => {
    const expired = insertRow({ expiresAt: '2000-01-01T00:00:00.000Z' })
    try {
      expect(enableDataBySlug(expired)).toBe(false)
      expect(findUploadBySlug(expired)?.data_enabled).toBe(0)
      expect(enableDataBySlug(`missing-${randomUUID()}`)).toBe(false)
    } finally {
      deleteUploadBySlug(expired)
    }
  })

  it('keeps records when data is disabled and reports a missing row', () => {
    const slug = insertRow()
    try {
      enableDataBySlug(slug)
      expect(disableDataBySlug(slug)).toBe(true)
      expect(findUploadBySlug(slug)?.data_enabled).toBe(0)
      expect(disableDataBySlug(`missing-${randomUUID()}`)).toBe(false)
    } finally {
      deleteUploadBySlug(slug)
    }
  })
})

describe('data access requires a live password', () => {
  it('fails closed when the password was cleared', () => {
    expect(() => requireDataEnabled(row({ password_hash: null }))).toThrowError(/Not found/)
  })

  it('fails closed when data is disabled', () => {
    expect(() => requireDataEnabled(row({ data_enabled: 0 }))).toThrowError(/Not found/)
  })

  it('accepts an enabled, password-protected row', () => {
    expect(() => requireDataEnabled(row())).not.toThrow()
  })
})

describe('rate limit bucket cap', () => {
  it('denies new keys once the cap is reached while existing keys keep working', () => {
    resetSiteRateLimits()
    const first = 'site-first'
    expect(checkDataRequestRate(first).allowed).toBe(true)

    // Fill the request bucket map to its 10,000-key cap.
    for (let i = 0; i < 10_000; i++) {
      checkDataRequestRate(`site-${i}`)
    }

    const overflow = checkDataRequestRate('site-overflow')
    expect(overflow.allowed).toBe(false)
    expect(overflow.retryAfter).toBeGreaterThan(0)

    // A key already tracked is still served.
    expect(checkDataRequestRate(first).allowed).toBe(true)
  })
})

describe('host classification', () => {
  afterEach(() => resetSiteRateLimits())

  it('treats every host under the site base as a site host', () => {
    vi.stubEnv('JOLT_APP_ORIGIN', 'https://host.example.com')
    vi.stubEnv('JOLT_SITE_BASE_ORIGIN', 'https://sites.example.net')
    expect(isSiteBaseHost('quick-dragon-42.sites.example.net')).toBe(true)
    expect(isSiteBaseHost('a.b.sites.example.net')).toBe(true)
    expect(isSiteBaseHost('sites.example.net')).toBe(true)
    expect(isSiteBaseHost('host.example.com')).toBe(false)
    expect(isSiteBaseHost(undefined)).toBe(false)
  })

  it('recognises only the configured app origin, including its port', () => {
    vi.stubEnv('JOLT_APP_ORIGIN', 'https://host.example.com:8443')
    vi.stubEnv('JOLT_SITE_BASE_ORIGIN', 'https://sites.example.net')
    expect(isAppOriginHost('host.example.com:8443')).toBe(true)
    expect(isAppOriginHost('host.example.com')).toBe(false)
    expect(isAppOriginHost('elsewhere.test')).toBe(false)
  })
})
