import { describe, it, expect, beforeEach } from 'vitest'
import { useResultStorage, type UploadResult } from './useResultStorage'

const RESULT_STORAGE_KEY = 'jolthost-last-upload'
const RESULT_BY_SLUG_PREFIX = 'jolthost-result-'

function makeResult(overrides: Partial<UploadResult> = {}): UploadResult {
  return {
    slug: 'quick-apple-42',
    url: 'https://quick-apple-42.sites.example.net/',
    entry_point: 'quick-apple-42/index.html',
    owner_token: 'owner-token-123',
    expires_at: '2026-10-02T00:00:00.000Z',
    ...overrides,
  }
}

describe('useResultStorage', () => {
  beforeEach(() => {
    sessionStorage.clear()
    localStorage.clear()
  })

  it('saveResult() writes both the latest and per-slug sessionStorage keys', () => {
    const { saveResult } = useResultStorage()
    saveResult(makeResult())

    const latest = JSON.parse(sessionStorage.getItem(RESULT_STORAGE_KEY)!)
    const bySlug = JSON.parse(sessionStorage.getItem(`${RESULT_BY_SLUG_PREFIX}quick-apple-42`)!)
    expect(latest.slug).toBe('quick-apple-42')
    expect(latest.url_with_unlock).toBeUndefined()
    expect(bySlug.slug).toBe('quick-apple-42')
  })

  it('saveResult() keeps the creation result out of localStorage', () => {
    const { saveResult } = useResultStorage()
    saveResult(makeResult())
    expect(localStorage.length).toBe(0)
  })

  it('saveResult() prefers the supplied form title over the result title', () => {
    const { saveResult, readResult } = useResultStorage()
    saveResult(makeResult({ title: 'from result' }), { title: '  From the form  ' })

    expect(readResult('quick-apple-42')?.title).toBe('From the form')
  })

  it('saveResult() falls back to the result title and drops blank titles', () => {
    const { saveResult, readResult } = useResultStorage()
    saveResult(makeResult({ title: 'from result' }), { title: '   ' })
    expect(readResult('quick-apple-42')?.title).toBe('from result')

    saveResult(makeResult({ slug: 'plain-1' }), { title: '' })
    expect(readResult('plain-1')?.title).toBeUndefined()
  })

  it('readResult() round-trips owner token and unlock URL for the result page', () => {
    const { saveResult, readResult } = useResultStorage()
    saveResult(makeResult({ url_with_unlock: 'https://quick-apple-42.sites.example.net/?unlock=abc' }))

    const stored = readResult('quick-apple-42')
    expect(stored?.owner_token).toBe('owner-token-123')
    expect(stored?.url_with_unlock).toBe('https://quick-apple-42.sites.example.net/?unlock=abc')
    expect(stored?.expires_at).toBe('2026-10-02T00:00:00.000Z')
  })

  it('readResult() returns null for an unknown slug and for invalid JSON', () => {
    const { readResult } = useResultStorage()
    expect(readResult('missing-slug')).toBeNull()

    sessionStorage.setItem(`${RESULT_BY_SLUG_PREFIX}broken`, '{ not valid }}')
    expect(readResult('broken')).toBeNull()
  })
})
