import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'crypto'
import {
  insertUpload,
  findUploadBySlug,
  deleteUploadBySlug,
  updateEntryPointIfUnchanged,
} from './db'

const PAST = '2000-01-01T00:00:00.000Z'
const FUTURE = '2099-01-01T00:00:00.000Z'

function uniqueSlug() {
  return `entry-${randomUUID()}`
}

describe('updateEntryPointIfUnchanged', () => {
  const inserted: string[] = []

  afterEach(() => {
    for (const slug of inserted.splice(0)) deleteUploadBySlug(slug)
  })

  function seed(slug: string, expiresAt: string | null = null) {
    inserted.push(slug)
    insertUpload(randomUUID(), slug, `${slug}/index.html`, null, null, expiresAt)
    return `${slug}/index.html`
  }

  it('switches the entry point when the current value matches', () => {
    const slug = uniqueSlug()
    const current = seed(slug)

    const changed = updateEntryPointIfUnchanged(slug, current, `.content/${slug}/gen/index.html`)

    expect(changed).toBe(true)
    expect(findUploadBySlug(slug)?.entry_point).toBe(`.content/${slug}/gen/index.html`)
  })

  it('refuses to switch when the observed entry point is stale', () => {
    const slug = uniqueSlug()
    const current = seed(slug)

    const changed = updateEntryPointIfUnchanged(slug, `${slug}/other.html`, `.content/${slug}/gen/index.html`)

    expect(changed).toBe(false)
    expect(findUploadBySlug(slug)?.entry_point).toBe(current)
  })

  it('refuses to switch an expired upload', () => {
    const slug = uniqueSlug()
    const current = seed(slug, PAST)

    const changed = updateEntryPointIfUnchanged(slug, current, `.content/${slug}/gen/index.html`)

    expect(changed).toBe(false)
    expect(findUploadBySlug(slug)?.entry_point).toBe(current)
  })

  it('switches an upload that expires in the future', () => {
    const slug = uniqueSlug()
    const current = seed(slug, FUTURE)

    expect(updateEntryPointIfUnchanged(slug, current, `.content/${slug}/gen/index.html`)).toBe(true)
  })

  it('is idempotent: a second call with the old value fails', () => {
    const slug = uniqueSlug()
    const current = seed(slug)

    expect(updateEntryPointIfUnchanged(slug, current, `.content/${slug}/gen1/index.html`)).toBe(true)
    expect(updateEntryPointIfUnchanged(slug, current, `.content/${slug}/gen2/index.html`)).toBe(false)
  })
})
