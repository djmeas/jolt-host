import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  canonicalSiteUrl,
  getSiteHostConfig,
  isBlockedAppPath,
  isJoltHostedPath,
  isLoopbackHost,
  legacyViewTarget,
  matchSiteHost,
  siteOriginForSlug,
} from './site-host'

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('JOLT_APP_ORIGIN', 'http://app.test:3000')
  vi.stubEnv('JOLT_SITE_BASE_ORIGIN', 'http://sites.test:8080')
})

afterEach(() => vi.unstubAllEnvs())

describe('site host matching', () => {
  it('extracts the slug from <slug>.<base host>', () => {
    expect(matchSiteHost('quick-dragon-42.sites.test:8080')).toEqual({ slug: 'quick-dragon-42' })
  })

  it('rejects the bare base host, the app host, and unrelated hosts', () => {
    expect(matchSiteHost('sites.test:8080')).toBeNull()
    expect(matchSiteHost('app.test:3000')).toBeNull()
    expect(matchSiteHost('example.com')).toBeNull()
    expect(matchSiteHost(undefined)).toBeNull()
  })

  it('rejects extra labels and a wrong port', () => {
    expect(matchSiteHost('a.b.sites.test:8080')).toBeNull()
    expect(matchSiteHost('quick-dragon-42.sites.test')).toBeNull()
    expect(matchSiteHost('quick-dragon-42.sites.test:3000')).toBeNull()
  })

  it('rejects hostnames that are not a valid slug label', () => {
    expect(matchSiteHost('Quick_Dragon.sites.test:8080')).toBeNull()
    expect(matchSiteHost('-leading.sites.test:8080')).toBeNull()
  })

  it('treats default ports as equivalent', () => {
    vi.stubEnv('JOLT_APP_ORIGIN', 'https://app.example.com')
    vi.stubEnv('JOLT_SITE_BASE_ORIGIN', 'https://sites.example.net')
    expect(matchSiteHost('quick-dragon-42.sites.example.net')).toEqual({
      slug: 'quick-dragon-42',
    })
    expect(matchSiteHost('quick-dragon-42.sites.example.net:443')).toEqual({
      slug: 'quick-dragon-42',
    })
  })
})

describe('canonical URLs', () => {
  it('builds scheme, slug host, and port', () => {
    expect(siteOriginForSlug('quick-dragon-42')).toBe('http://quick-dragon-42.sites.test:8080')
    expect(canonicalSiteUrl('quick-dragon-42')).toBe('http://quick-dragon-42.sites.test:8080/')
  })

  it('rejects a slug that is not a valid host label', () => {
    expect(canonicalSiteUrl('bad/slug')).toBeNull()
  })

  it('carries only the unlock token across a legacy redirect', () => {
    const target = legacyViewTarget(
      'quick-dragon-42',
      'assets/app.js',
      'unlock-token'
    )
    expect(target).toBe(
      'http://quick-dragon-42.sites.test:8080/assets/app.js?unlock=unlock-token'
    )

    const stripped = legacyViewTarget('quick-dragon-42', '', null)
    expect(stripped).toBe('http://quick-dragon-42.sites.test:8080/')
  })
})

describe('loopback hosts', () => {
  it('accepts loopback hosts with or without a port', () => {
    for (const host of [
      'localhost',
      'localhost:3000',
      '127.0.0.1',
      '127.0.0.1:8080',
      '[::1]:3000',
      'sites.localhost:3000',
      'quick-dragon-42.sites.localhost:3000',
    ]) {
      expect(isLoopbackHost(host), host).toBe(true)
    }
  })

  it('rejects non-loopback hosts and empty values', () => {
    for (const host of [
      'example.com',
      'localhost.example.com',
      'notlocalhost',
      '127.0.0.2',
      'sites.example.net:3000',
      '',
      undefined,
    ]) {
      expect(isLoopbackHost(host), String(host)).toBe(false)
    }
  })
})

describe('deployment configuration', () => {
  it('accepts separate registrable domains over HTTPS in production', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('JOLT_APP_ORIGIN', 'https://host.example.com')
    vi.stubEnv('JOLT_SITE_BASE_ORIGIN', 'https://sites.example.net')
    expect(getSiteHostConfig().configured).toBe(true)
  })

  it('rejects same registrable domain, sibling subdomains, and plain HTTP', () => {
    vi.stubEnv('NODE_ENV', 'production')

    vi.stubEnv('JOLT_SITE_BASE_ORIGIN', 'https://sites.example.com')
    expect(getSiteHostConfig().configured).toBe(false)

    vi.stubEnv('JOLT_SITE_BASE_ORIGIN', 'https://sites.example.net')
    vi.stubEnv('JOLT_APP_ORIGIN', 'http://host.example.com')
    expect(getSiteHostConfig().configured).toBe(false)
  })

  it('requires configuration in production', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('JOLT_APP_ORIGIN', '')
    vi.stubEnv('JOLT_SITE_BASE_ORIGIN', '')
    expect(getSiteHostConfig().configured).toBe(false)
    expect(siteOriginForSlug('anything')).toBeNull()
  })

  it('accepts a loopback origin pair over http in production', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('JOLT_APP_ORIGIN', 'http://localhost:3000')
    vi.stubEnv('JOLT_SITE_BASE_ORIGIN', 'http://sites.localhost:3000')
    const config = getSiteHostConfig()
    expect(config.configured).toBe(true)
    expect(siteOriginForSlug('quick-dragon-42')).toBe('http://quick-dragon-42.sites.localhost:3000')
    expect(matchSiteHost('quick-dragon-42.sites.localhost:3000')).toEqual({
      slug: 'quick-dragon-42',
    })
  })

  it('requires both origins of a production pair to be loopback for http', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('JOLT_APP_ORIGIN', 'http://localhost:3000')
    vi.stubEnv('JOLT_SITE_BASE_ORIGIN', 'https://sites.example.net')
    expect(getSiteHostConfig().configured).toBe(false)

    vi.stubEnv('JOLT_APP_ORIGIN', 'https://host.example.com')
    vi.stubEnv('JOLT_SITE_BASE_ORIGIN', 'http://sites.localhost:3000')
    expect(getSiteHostConfig().configured).toBe(false)
  })

  it('falls back to loopback defaults outside production', () => {
    vi.stubEnv('JOLT_APP_ORIGIN', '')
    vi.stubEnv('JOLT_SITE_BASE_ORIGIN', '')
    vi.stubEnv('PORT', '3999')
    const config = getSiteHostConfig()
    expect(config.configured).toBe(true)
    expect(config.app?.origin).toBe('http://localhost:3999')
    expect(config.site?.origin).toBe('http://sites.localhost:3999')
  })

  it('rejects a site base origin that is the app host', () => {
    vi.stubEnv('JOLT_APP_ORIGIN', 'http://app.test')
    vi.stubEnv('JOLT_SITE_BASE_ORIGIN', 'http://app.test')
    expect(getSiteHostConfig().configured).toBe(false)
  })
})

describe('path classification', () => {
  it('blocks every application route prefix on a site origin', () => {
    expect(isBlockedAppPath('/api/admin/session')).toBe(true)
    expect(isBlockedAppPath('/api')).toBe(true)
    expect(isBlockedAppPath('/admin/login')).toBe(true)
    expect(isBlockedAppPath('/dashboard')).toBe(true)
    expect(isBlockedAppPath('/view/anything')).toBe(true)
    expect(isBlockedAppPath('/data/sites/x.sqlite')).toBe(true)
  })

  it('allows ordinary site asset paths', () => {
    expect(isBlockedAppPath('/')).toBe(false)
    expect(isBlockedAppPath('/index.html')).toBe(false)
    expect(isBlockedAppPath('/assets/app.js')).toBe(false)
    expect(isBlockedAppPath('/apix')).toBe(false)
    expect(isBlockedAppPath('/datafile.txt')).toBe(false)
  })

  it('recognises only the Jolt-owned hosted paths', () => {
    expect(isJoltHostedPath('/_jolt/unlock')).toBe(true)
    expect(isJoltHostedPath('/_jolt/data/login')).toBe(true)
    expect(isJoltHostedPath('/_jolt/data/v1/collections/todos/items')).toBe(true)
    expect(isJoltHostedPath('/_jolt')).toBe(false)
    expect(isJoltHostedPath('/_jolt/other')).toBe(false)
  })
})
