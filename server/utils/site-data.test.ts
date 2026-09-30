import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import {
  COLLECTION_PATTERN,
  MAX_COLLECTIONS,
  MAX_RECORDS,
  MAX_RECORD_BYTES,
  createItem,
  deleteItem,
  deleteSiteData,
  getSiteDataDir,
  listItems,
  reconcileSiteData,
  replaceItem,
  serializeRecordValue,
} from './site-data'

const SITES_DIR = getSiteDataDir()
const created: string[] = []

function freshId(): string {
  const id = randomUUID()
  created.push(id)
  return id
}

function dbFile(id: string): string {
  return join(SITES_DIR, `${id}.sqlite`)
}

/** Seeds a database directly so quota boundaries can be tested cheaply. */
function seed(id: string, rows: { collection: string; value: string }[]): void {
  mkdirSync(SITES_DIR, { recursive: true })
  const db = new Database(dbFile(id))
  db.exec(`CREATE TABLE IF NOT EXISTS items (
    collection TEXT NOT NULL, id TEXT NOT NULL, value_json TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (collection, id))`)
  const insert = db.prepare(
    'INSERT INTO items (collection, id, value_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  )
  rows.forEach((row, index) => {
    insert.run(row.collection, randomUUID(), row.value, `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`, '2026-01-01T00:00:00.000Z')
  })
  db.close()
}

beforeEach(() => {
  mkdirSync(SITES_DIR, { recursive: true })
})

afterEach(() => {
  for (const id of created) deleteSiteData(id)
  created.length = 0
})

describe('serializeRecordValue', () => {
  it('accepts a JSON object', () => {
    expect(serializeRecordValue({ a: 1 })).toBe('{"a":1}')
  })

  it('rejects arrays, null, and primitives', () => {
    expect(() => serializeRecordValue([1, 2])).toThrowError(/JSON object/)
    expect(() => serializeRecordValue(null)).toThrowError(/JSON object/)
    expect(() => serializeRecordValue('text')).toThrowError(/JSON object/)
    expect(() => serializeRecordValue(7)).toThrowError(/JSON object/)
  })

  it('rejects a value over the per-record byte limit', () => {
    const big = { text: 'x'.repeat(MAX_RECORD_BYTES) }
    expect(() => serializeRecordValue(big)).toThrowError(/record limit/)
  })
})

describe('per-site database files', () => {
  it('derives the filename from the validated upload id', () => {
    const id = freshId()
    createItem(id, 'todos', '{"done":false}')
    expect(existsSync(dbFile(id))).toBe(true)
  })

  it('rejects an upload id that is not a UUID, so the path cannot be forged', () => {
    expect(() => listItems('../escape', 'todos', 10, 0)).toThrowError()
    expect(() => createItem('../../etc/passwd', 'todos', '{}')).toThrowError()
  })

  it('does not create a database file when listing an unknown collection', () => {
    const id = freshId()
    const page = listItems(id, 'todos', 10, 0)
    expect(page).toEqual({ items: [], next_offset: null })
    expect(existsSync(dbFile(id))).toBe(false)
  })
})

describe('record lifecycle', () => {
  it('creates, lists, replaces, and deletes records', () => {
    const id = freshId()
    const first = createItem(id, 'todos', '{"title":"one","done":false}')
    const second = createItem(id, 'todos', '{"title":"two","done":false}')

    const page = listItems(id, 'todos', 50, 0)
    expect(page.items.map((i) => i.id)).toEqual([first.id, second.id])
    expect(page.next_offset).toBeNull()

    const updated = replaceItem(id, 'todos', first.id, '{"title":"one","done":true}')
    expect(updated?.value).toEqual({ title: 'one', done: true })
    expect(updated?.created_at).toBe(first.created_at)

    expect(deleteItem(id, 'todos', first.id)).toBe(true)
    expect(deleteItem(id, 'todos', first.id)).toBe(false)
    expect(listItems(id, 'todos', 50, 0).items.map((i) => i.id)).toEqual([second.id])
  })

  it('returns null when replacing or deleting a record that does not exist', () => {
    const id = freshId()
    createItem(id, 'todos', '{}')
    expect(replaceItem(id, 'todos', randomUUID(), '{}')).toBeNull()
    expect(replaceItem(id, 'other', 'anything', '{}')).toBeNull()
    expect(deleteItem(id, 'todos', randomUUID())).toBe(false)
  })

  it('orders deterministically and paginates with next_offset', () => {
    const id = freshId()
    for (let i = 0; i < 5; i++) createItem(id, 'todos', `{"n":${i}}`)

    const firstPage = listItems(id, 'todos', 2, 0)
    expect(firstPage.items).toHaveLength(2)
    expect(firstPage.next_offset).toBe(2)

    const secondPage = listItems(id, 'todos', 2, firstPage.next_offset!)
    expect(secondPage.next_offset).toBe(4)
    expect(secondPage.items[0].value).toEqual({ n: 2 })

    const lastPage = listItems(id, 'todos', 2, 4)
    expect(lastPage.items).toHaveLength(1)
    expect(lastPage.next_offset).toBeNull()
  })

  it('keeps collections isolated from each other', () => {
    const id = freshId()
    createItem(id, 'todos', '{"a":1}')
    createItem(id, 'notes', '{"b":2}')
    expect(listItems(id, 'todos', 50, 0).items).toHaveLength(1)
    expect(listItems(id, 'notes', 50, 0).items[0].value).toEqual({ b: 2 })
    expect(listItems(id, 'other', 50, 0).items).toHaveLength(0)
  })

  it('uses separate database files per site', () => {
    const a = freshId()
    const b = freshId()
    createItem(a, 'todos', '{"site":"a"}')
    createItem(b, 'todos', '{"site":"b"}')
    expect(listItems(a, 'todos', 50, 0).items[0].value).toEqual({ site: 'a' })
    expect(listItems(b, 'todos', 50, 0).items[0].value).toEqual({ site: 'b' })
    expect(dbFile(a)).not.toBe(dbFile(b))
  })
})

describe('transactional quotas', () => {
  it('rejects a record over the per-record limit', () => {
    const id = freshId()
    const json = serializeRecordValue({ ok: true })
    expect(createItem(id, 'todos', json)).toBeTruthy()
    const oversized = `{"text":"${'x'.repeat(MAX_RECORD_BYTES)}"}`
    expect(() => createItem(id, 'todos', oversized)).toThrowError(/record limit/)
  })

  it('rejects more than the maximum number of collections with records', () => {
    const id = freshId()
    seed(
      id,
      Array.from({ length: MAX_COLLECTIONS }, (_, i) => ({
        collection: `col-${i}`,
        value: '{"a":1}',
      }))
    )
    expect(() => createItem(id, 'one-more', '{"a":1}')).toThrowError(/collection limit/)

    // Adding to a collection that already has records is still allowed.
    expect(createItem(id, 'col-0', '{"a":2}')).toBeTruthy()
  })

  it('rejects the record past the per-site record limit', () => {
    const id = freshId()
    seed(
      id,
      Array.from({ length: MAX_RECORDS }, () => ({ collection: 'todos', value: '{"a":1}' }))
    )
    expect(() => createItem(id, 'todos', '{"a":1}')).toThrowError(/record limit/)
    // Replacing an existing record is not blocked by the record count.
    const existing = listItems(id, 'todos', 1, 0).items[0]
    expect(replaceItem(id, 'todos', existing.id, '{"a":9}')).not.toBeNull()
  })

  it('counts replacements against the total payload quota', () => {
    const id = freshId()
    const chunk = `{"text":"${'y'.repeat(2000)}"}`
    seed(
      id,
      Array.from({ length: 521 }, () => ({ collection: 'todos', value: chunk }))
    )
    const existing = listItems(id, 'todos', 1, 0).items[0]
    // A record that is itself within the 4 KiB limit can still push the site
    // past its 1 MiB total.
    const grown = `{"text":"${'y'.repeat(4085)}"}`
    expect(Buffer.byteLength(grown, 'utf8')).toBe(MAX_RECORD_BYTES)
    expect(() => replaceItem(id, 'todos', existing.id, grown)).toThrowError(/1 MiB/)
    // Shrinking is fine.
    expect(replaceItem(id, 'todos', existing.id, '{"text":"small"}')).not.toBeNull()
  })
})

describe('file cleanup', () => {
  it('removes the database file and its WAL sidecars', () => {
    const id = freshId()
    createItem(id, 'todos', '{}')
    writeFileSync(`${dbFile(id)}-wal`, '')
    writeFileSync(`${dbFile(id)}-shm`, '')
    deleteSiteData(id)
    expect(existsSync(dbFile(id))).toBe(false)
    expect(existsSync(`${dbFile(id)}-wal`)).toBe(false)
    expect(existsSync(`${dbFile(id)}-shm`)).toBe(false)
  })

  it('reconciles orphan databases but keeps live ones', () => {
    const live = freshId()
    const orphan = freshId()
    createItem(live, 'todos', '{}')
    createItem(orphan, 'todos', '{}')

    reconcileSiteData([live], 0)

    expect(existsSync(dbFile(live))).toBe(true)
    expect(existsSync(dbFile(orphan))).toBe(false)
  })

  it('keeps recent orphans so a concurrent create is never destroyed', () => {
    const orphan = freshId()
    createItem(orphan, 'todos', '{}')
    reconcileSiteData([], 60_000)
    expect(existsSync(dbFile(orphan))).toBe(true)
  })
})

describe('collection name pattern', () => {
  it('accepts only lowercase, dash/underscore separated names', () => {
    expect(COLLECTION_PATTERN.test('todos')).toBe(true)
    expect(COLLECTION_PATTERN.test('my-list_1')).toBe(true)
    expect(COLLECTION_PATTERN.test('Todos')).toBe(false)
    expect(COLLECTION_PATTERN.test('1todos')).toBe(false)
    expect(COLLECTION_PATTERN.test('-todos')).toBe(false)
    expect(COLLECTION_PATTERN.test('a'.repeat(41))).toBe(false)
    expect(COLLECTION_PATTERN.test('todos; DROP TABLE items')).toBe(false)
  })
})
