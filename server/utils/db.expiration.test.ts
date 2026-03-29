import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'crypto'
import { insertUpload, getExpiredUploadSlugs, deleteUploadBySlug, findUploadBySlug } from './db'

// Clearly past and future ISO timestamps that SQLite datetime() can compare reliably
const PAST = '2000-01-01T00:00:00.000Z'
const FUTURE = '2099-01-01T00:00:00.000Z'

function uniqueSlug() {
  return `test-${randomUUID()}`
}

function seed(slug: string, expiresAt: string | null) {
  insertUpload(randomUUID(), slug, `${slug}/index.html`, null, null, expiresAt)
}

describe('getExpiredUploadSlugs', () => {
  const inserted: string[] = []

  afterEach(() => {
    for (const slug of inserted.splice(0)) {
      deleteUploadBySlug(slug)
    }
  })

  it('returns empty array when there are no uploads', () => {
    expect(getExpiredUploadSlugs()).toEqual([])
  })

  it('returns slug for an upload whose expires_at is in the past', () => {
    const slug = uniqueSlug()
    inserted.push(slug)
    seed(slug, PAST)

    const result = getExpiredUploadSlugs()
    expect(result).toContain(slug)
  })

  it('does not return slug for an upload whose expires_at is in the future', () => {
    const slug = uniqueSlug()
    inserted.push(slug)
    seed(slug, FUTURE)

    expect(getExpiredUploadSlugs()).not.toContain(slug)
  })

  it('does not return slug for an upload with no expiration (expires_at is null)', () => {
    const slug = uniqueSlug()
    inserted.push(slug)
    seed(slug, null)

    expect(getExpiredUploadSlugs()).not.toContain(slug)
  })

  it('returns all expired slugs when multiple are expired', () => {
    const a = uniqueSlug()
    const b = uniqueSlug()
    inserted.push(a, b)
    seed(a, PAST)
    seed(b, PAST)

    const result = getExpiredUploadSlugs()
    expect(result).toContain(a)
    expect(result).toContain(b)
  })

  it('does not include non-expired uploads when mixed with expired ones', () => {
    const expired = uniqueSlug()
    const active = uniqueSlug()
    const never = uniqueSlug()
    inserted.push(expired, active, never)
    seed(expired, PAST)
    seed(active, FUTURE)
    seed(never, null)

    const result = getExpiredUploadSlugs()
    expect(result).toContain(expired)
    expect(result).not.toContain(active)
    expect(result).not.toContain(never)
  })
})

describe('deleteUploadBySlug', () => {
  it('returns true and removes the record when slug exists', () => {
    const slug = uniqueSlug()
    seed(slug, null)

    const result = deleteUploadBySlug(slug)
    expect(result).toBe(true)
    expect(findUploadBySlug(slug)).toBeUndefined()
  })

  it('returns false when slug does not exist', () => {
    expect(deleteUploadBySlug('slug-that-does-not-exist')).toBe(false)
  })

  it('returns false on a second delete of the same slug', () => {
    const slug = uniqueSlug()
    seed(slug, null)
    deleteUploadBySlug(slug)

    expect(deleteUploadBySlug(slug)).toBe(false)
  })
})
