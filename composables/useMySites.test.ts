import { describe, it, expect, beforeEach } from 'vitest'
import { useMySites, type MySite } from './useMySites'

const STORAGE_KEY = 'joltHost_mySites'

function makeSite(overrides: Partial<MySite> = {}): MySite {
  return {
    siteUrl: 'https://example.jolt.host/test-abc',
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
    ...overrides,
  }
}

describe('useMySites', () => {
  beforeEach(() => {
    localStorage.clear()
    // Reset shared Nuxt state for the 'mySites' key
    useMySites().sites.value = []
  })

  it('load() returns empty array when localStorage is empty', () => {
    const { sites, load } = useMySites()
    load()
    expect(sites.value).toEqual([])
  })

  it('addSite() exposes the new site in reactive state', () => {
    const { sites, addSite } = useMySites()
    addSite(makeSite())
    expect(sites.value).toHaveLength(1)
    expect(sites.value[0].siteUrl).toBe('https://example.jolt.host/test-abc')
  })

  it('addSite() persists the site to localStorage', () => {
    const { addSite } = useMySites()
    addSite(makeSite({ title: 'Persisted Site' }))

    const stored: MySite[] = JSON.parse(localStorage.getItem(STORAGE_KEY)!)
    expect(stored).toHaveLength(1)
    expect(stored[0].title).toBe('Persisted Site')
  })

  it('addSite() ignores a duplicate siteUrl', () => {
    const { sites, addSite } = useMySites()
    const site = makeSite()
    addSite(site)
    addSite(site)
    expect(sites.value).toHaveLength(1)
  })

  it('addSite() prepends entries so the most recent is first', () => {
    const { sites, addSite } = useMySites()
    addSite(makeSite({ siteUrl: 'https://first.example.com' }))
    addSite(makeSite({ siteUrl: 'https://second.example.com' }))
    expect(sites.value[0].siteUrl).toBe('https://second.example.com')
    expect(sites.value[1].siteUrl).toBe('https://first.example.com')
  })

  it('load() reads previously persisted sites from localStorage', () => {
    const seed: MySite[] = [makeSite({ title: 'Seed Site', siteUrl: 'https://seed.example.com' })]
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))

    const { sites, load } = useMySites()
    load()
    expect(sites.value).toHaveLength(1)
    expect(sites.value[0].title).toBe('Seed Site')
  })

  it('load() returns empty array when localStorage contains invalid JSON', () => {
    localStorage.setItem(STORAGE_KEY, '{ not valid }}')
    const { sites, load } = useMySites()
    load()
    expect(sites.value).toEqual([])
  })

  it('clearSites() empties both localStorage and reactive state', () => {
    const { sites, addSite, clearSites } = useMySites()
    addSite(makeSite())
    clearSites()
    expect(sites.value).toEqual([])
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })
})
