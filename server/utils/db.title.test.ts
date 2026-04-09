import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'crypto'
import { insertUpload, findUploadBySlug, deleteUploadBySlug, getAllUploads } from './db'

function uniqueSlug() {
  return `test-title-${randomUUID()}`
}

describe('title field', () => {
  const inserted: string[] = []

  afterEach(() => {
    for (const slug of inserted.splice(0)) {
      deleteUploadBySlug(slug)
    }
  })

  describe('insertUpload / findUploadBySlug', () => {
    it('stores and returns the title when provided', () => {
      const slug = uniqueSlug()
      inserted.push(slug)
      insertUpload(randomUUID(), slug, `${slug}/index.html`, null, null, null, null, 'My Awesome Site')

      const row = findUploadBySlug(slug)
      expect(row?.title).toBe('My Awesome Site')
    })

    it('returns null title when none was provided', () => {
      const slug = uniqueSlug()
      inserted.push(slug)
      insertUpload(randomUUID(), slug, `${slug}/index.html`, null, null, null, null, null)

      const row = findUploadBySlug(slug)
      expect(row?.title).toBeNull()
    })

    it('title is independent of other fields', () => {
      const slug = uniqueSlug()
      inserted.push(slug)
      const expires = '2099-01-01T00:00:00.000Z'
      insertUpload(randomUUID(), slug, `${slug}/index.html`, null, 'owner-token', expires, null, 'Titled Site')

      const row = findUploadBySlug(slug)
      expect(row?.title).toBe('Titled Site')
      expect(row?.expires_at).toBe(expires)
      expect(row?.owner_token).toBe('owner-token')
    })
  })

  describe('getAllUploads', () => {
    it('includes the title field in returned items', () => {
      const slug = uniqueSlug()
      inserted.push(slug)
      insertUpload(randomUUID(), slug, `${slug}/index.html`, null, null, null, null, 'Listed Title')

      const items = getAllUploads()
      const found = items.find((i) => i.slug === slug)
      expect(found).toBeDefined()
      expect(found?.title).toBe('Listed Title')
    })

    it('returns null title for uploads without one', () => {
      const slug = uniqueSlug()
      inserted.push(slug)
      insertUpload(randomUUID(), slug, `${slug}/index.html`, null, null, null, null, null)

      const items = getAllUploads()
      const found = items.find((i) => i.slug === slug)
      expect(found?.title).toBeNull()
    })
  })
})
