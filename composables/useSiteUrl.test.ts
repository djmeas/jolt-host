import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { buildSiteUrl, readServerOrigins, resolveSiteOrigins, useSiteUrl } from './useSiteUrl'
import siteOriginsPlugin from '../plugins/site-origins'

const STALE = {
  appOrigin: 'http://stale-build-app.invalid',
  siteBaseOrigin: 'http://stale-build-sites.invalid',
}
const LIVE = { appOrigin: 'http://localhost:3977', siteBaseOrigin: 'http://sites.localhost:3977' }

let requestEvent: unknown = undefined

// Only the request event is mocked: the Nuxt test runtime keeps its real runtime
// config, so this suite does not disturb the app/router initialization.
mockNuxtImport('useRequestEvent', () => () => requestEvent)

function resetOrigins() {
  useState('jolt-site-origins').value = undefined
}

afterEach(() => {
  requestEvent = undefined
})

describe('resolveSiteOrigins', () => {
  it('prefers the live server values over the build-time public config', () => {
    // The regression: a bundle built with a different origin must not win.
    expect(resolveSiteOrigins(LIVE, STALE)).toEqual(LIVE)
  })

  it('falls back to public config when the request publishes nothing', () => {
    expect(resolveSiteOrigins(undefined, { siteBaseOrigin: 'http://sites.localhost:3000' })).toEqual({
      appOrigin: '',
      siteBaseOrigin: 'http://sites.localhost:3000',
    })
  })

  it('returns empty values when neither source is available', () => {
    expect(resolveSiteOrigins(undefined, undefined)).toEqual({ appOrigin: '', siteBaseOrigin: '' })
  })
})

describe('readServerOrigins', () => {
  it('reads the origins the server published on the event context', () => {
    expect(readServerOrigins({ context: { siteOrigins: LIVE } })).toEqual(LIVE)
  })

  it('returns null for events without published origins', () => {
    expect(readServerOrigins(undefined)).toBeNull()
    expect(readServerOrigins({ context: {} })).toBeNull()
    expect(readServerOrigins({ context: { siteOrigins: 'nonsense' } })).toBeNull()
  })
})

describe('buildSiteUrl', () => {
  it('prefixes the slug to the configured host and keeps the port', () => {
    expect(buildSiteUrl('https://sites.example.net', 'quick-dragon-42')).toBe(
      'https://quick-dragon-42.sites.example.net/'
    )
    expect(buildSiteUrl('http://sites.localhost:3000', 'quick-dragon-42')).toBe(
      'http://quick-dragon-42.sites.localhost:3000/'
    )
  })

  it('returns null when there is no usable base origin', () => {
    expect(buildSiteUrl('', 'quick-dragon-42')).toBeNull()
    expect(buildSiteUrl('not a url', 'quick-dragon-42')).toBeNull()
  })
})

describe('hosted origins reach pages that never used useSiteUrl', () => {
  beforeEach(() => {
    resetOrigins()
    requestEvent = { context: { siteOrigins: LIVE } }
  })

  it('seeds the state during any server render, not only the pages that need it', async () => {
    // The reported failure: a visitor lands on /paste (which never calls
    // useSiteUrl), so nothing seeded the state and a later client-side
    // navigation fell back to the build-time origins.
    await siteOriginsPlugin()

    expect(useState<typeof LIVE>('jolt-site-origins').value).toEqual(LIVE)
  })

  it('serves the live origin on the client after navigating from such a page', async () => {
    await siteOriginsPlugin()
    // Client side: no request event at all.
    requestEvent = undefined

    const { siteUrlFor } = useSiteUrl()
    expect(siteUrlFor('calm-falcon-3b4101')).toBe('http://calm-falcon-3b4101.sites.localhost:3977/')
    expect(siteUrlFor('calm-falcon-3b4101')).not.toContain('invalid')
  })

  it('does not overwrite origins a previous render already serialized', async () => {
    useState<typeof LIVE>('jolt-site-origins').value = { ...LIVE }
    requestEvent = { context: { siteOrigins: { ...LIVE, appOrigin: 'http://unexpected.invalid' } } }

    await siteOriginsPlugin()

    expect(useState<typeof LIVE>('jolt-site-origins').value).toEqual(LIVE)
  })
})

describe('useSiteUrl without a usable origin anywhere', () => {
  it('falls back to the app-origin legacy path instead of inventing a host', () => {
    resetOrigins()
    requestEvent = undefined

    const { siteUrlFor } = useSiteUrl()

    expect(siteUrlFor('calm-falcon-3b4101')).toBe('/view/calm-falcon-3b4101')
  })
})
