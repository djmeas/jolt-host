import { describe, it, expect, vi } from 'vitest'
import { generateSlug, generateUniqueSlug } from './slug'

describe('generateSlug', () => {
  it('returns slug in adjective-noun-hash format', () => {
    const slug = generateSlug()
    expect(slug).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{6}$/)
    const parts = slug.split('-')
    expect(parts).toHaveLength(3)
    expect(parts[2]).toHaveLength(6)
  })

  it('generates different slugs on multiple calls', () => {
    const slugs = new Set<string>()
    for (let i = 0; i < 50; i++) {
      slugs.add(generateSlug())
    }
    expect(slugs.size).toBeGreaterThan(1)
  })
})

describe('generateUniqueSlug', () => {
  it('returns slug when it does not exist', () => {
    const slug = generateUniqueSlug(() => false)
    expect(slug).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{6}$/)
  })

  it('retries until unique when exists returns true', () => {
    const seen = new Set<string>()
    let callCount = 0
    const slug = generateUniqueSlug((s) => {
      callCount++
      if (seen.has(s)) return true
      seen.add(s)
      return false
    })
    expect(slug).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{6}$/)
    expect(seen.has(slug)).toBe(true)
    expect(callCount).toBeGreaterThanOrEqual(1)
  })
})
