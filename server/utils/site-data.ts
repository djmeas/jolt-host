import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { createError } from 'h3'

/**
 * Per-site JSON record store.
 *
 * Each data-enabled upload owns one SQLite file named after its immutable UUID,
 * created lazily on the first authorized write. Uploaded content never runs on
 * the server and never supplies SQL: only JSON object values are accepted, and
 * every statement uses bound parameters.
 */

const TEST_MODE = process.env.NODE_ENV === 'test' || process.env.JOLT_TEST_MODE === '1'
const SITES_DIR = TEST_MODE
  ? join(process.cwd(), 'test', 'tmp-data', 'sites')
  : join(process.cwd(), 'data', 'sites')

export const COLLECTION_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/
export const MAX_COLLECTIONS = 10
export const MAX_RECORDS = 1000
export const MAX_RECORD_BYTES = 4096
export const MAX_TOTAL_BYTES = 1024 * 1024
export const LIST_DEFAULT_LIMIT = 50
export const LIST_MAX_LIMIT = 100
export const SITE_DATA_RETIRE_GRACE_MS = 5 * 60 * 1000

const BUSY_TIMEOUT_MS = 5000
const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SITE_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.sqlite(?:-(?:wal|shm))?$/

export type SiteRecord = { id: string; value: unknown; created_at: string; updated_at: string }
export type SiteRecordPage = { items: SiteRecord[]; next_offset: number | null }

export function getSiteDataDir(): string {
  return SITES_DIR
}

function requireUploadId(uploadId: string): string {
  if (!UPLOAD_ID_RE.test(uploadId)) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }
  return uploadId
}

function dbPathFor(uploadId: string): string {
  return join(SITES_DIR, `${requireUploadId(uploadId)}.sqlite`)
}

function openDb(uploadId: string): Database.Database {
  mkdirSync(SITES_DIR, { recursive: true })
  const db = new Database(dbPathFor(uploadId))
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('synchronous = NORMAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      value_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (collection, id)
    );
    CREATE INDEX IF NOT EXISTS idx_items_collection_created ON items (collection, created_at, id);
  `)
  return db
}

/** Validates and serializes a record value: JSON objects only, 4 KiB maximum. */
export function serializeRecordValue(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw createError({ statusCode: 400, message: 'value must be a JSON object' })
  }
  const json = JSON.stringify(value)
  if (json === undefined) {
    throw createError({ statusCode: 400, message: 'value must be a JSON object' })
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_RECORD_BYTES) {
    throw createError({
      statusCode: 413,
      message: `value exceeds the ${MAX_RECORD_BYTES}-byte record limit`,
    })
  }
  return json
}

type QuotaInput = {
  collection: string
  newBytes: number
  replacedBytes: number
  addingRecord: boolean
}

/** Quota checks run inside the write transaction, so concurrent writes cannot slip past them. */
function enforceQuota(db: Database.Database, input: QuotaInput): void {
  const totals = db
    .prepare('SELECT COUNT(*) AS records, COUNT(DISTINCT collection) AS collections FROM items')
    .get() as { records: number; collections: number }
  if (input.addingRecord && totals.records >= MAX_RECORDS) {
    throw createError({
      statusCode: 409,
      message: `This site has reached the ${MAX_RECORDS}-record limit`,
    })
  }
  if (input.addingRecord) {
    const inCollection = db
      .prepare('SELECT COUNT(*) AS n FROM items WHERE collection = ?')
      .get(input.collection) as { n: number }
    if (inCollection.n === 0 && totals.collections >= MAX_COLLECTIONS) {
      throw createError({
        statusCode: 409,
        message: `This site has reached the ${MAX_COLLECTIONS}-collection limit`,
      })
    }
  }
  const used = db
    .prepare('SELECT COALESCE(SUM(length(CAST(value_json AS BLOB))), 0) AS n FROM items')
    .get() as { n: number }
  if (used.n - input.replacedBytes + input.newBytes > MAX_TOTAL_BYTES) {
    throw createError({
      statusCode: 409,
      message: 'This site has reached its 1 MiB stored-data limit',
    })
  }
}

function recordFromRow(row: {
  id: string
  value_json: string
  created_at: string
  updated_at: string
}): SiteRecord {
  return {
    id: row.id,
    value: JSON.parse(row.value_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/** Lists one collection page. Never creates a database file. */
export function listItems(
  uploadId: string,
  collection: string,
  limit: number,
  offset: number
): SiteRecordPage {
  if (!existsSync(dbPathFor(uploadId))) return { items: [], next_offset: null }
  const db = openDb(uploadId)
  try {
    const rows = db
      .prepare(
        `SELECT id, value_json, created_at, updated_at FROM items
         WHERE collection = ? ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?`
      )
      .all(collection, limit + 1, offset) as {
      id: string
      value_json: string
      created_at: string
      updated_at: string
    }[]
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    return {
      items: page.map(recordFromRow),
      next_offset: hasMore ? offset + limit : null,
    }
  } finally {
    db.close()
  }
}

export function createItem(uploadId: string, collection: string, json: string): SiteRecord {
  const bytes = Buffer.byteLength(json, 'utf8')
  if (bytes > MAX_RECORD_BYTES) {
    throw createError({
      statusCode: 413,
      message: `value exceeds the ${MAX_RECORD_BYTES}-byte record limit`,
    })
  }
  const db = openDb(uploadId)
  const now = new Date().toISOString()
  const recordId = randomUUID()
  try {
    const write = db.transaction(() => {
      enforceQuota(db, { collection, newBytes: bytes, replacedBytes: 0, addingRecord: true })
      db.prepare(
        'INSERT INTO items (collection, id, value_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run(collection, recordId, json, now, now)
    })
    write.immediate()
    return { id: recordId, value: JSON.parse(json), created_at: now, updated_at: now }
  } finally {
    db.close()
  }
}

/** Replaces a record's whole value; returns null when the record does not exist. */
export function replaceItem(
  uploadId: string,
  collection: string,
  itemId: string,
  json: string
): SiteRecord | null {
  if (!existsSync(dbPathFor(uploadId))) return null
  const bytes = Buffer.byteLength(json, 'utf8')
  if (bytes > MAX_RECORD_BYTES) {
    throw createError({
      statusCode: 413,
      message: `value exceeds the ${MAX_RECORD_BYTES}-byte record limit`,
    })
  }
  const db = openDb(uploadId)
  const now = new Date().toISOString()
  try {
    // The row is read inside the IMMEDIATE transaction and the update's changed
    // count is checked, so a concurrent delete cannot make this report success
    // for a record that no longer exists.
    const write = db.transaction(() => {
      const existing = db
        .prepare(
          'SELECT created_at, length(CAST(value_json AS BLOB)) AS bytes FROM items WHERE collection = ? AND id = ?'
        )
        .get(collection, itemId) as { created_at: string; bytes: number } | undefined
      if (!existing) return null
      enforceQuota(db, {
        collection,
        newBytes: bytes,
        replacedBytes: existing.bytes,
        addingRecord: false,
      })
      const info = db
        .prepare('UPDATE items SET value_json = ?, updated_at = ? WHERE collection = ? AND id = ?')
        .run(json, now, collection, itemId)
      if (info.changes !== 1) return null
      return { created_at: existing.created_at }
    })
    const result = write.immediate()
    if (!result) return null
    return { id: itemId, value: JSON.parse(json), created_at: result.created_at, updated_at: now }
  } finally {
    db.close()
  }
}

export function deleteItem(uploadId: string, collection: string, itemId: string): boolean {
  if (!existsSync(dbPathFor(uploadId))) return false
  const db = openDb(uploadId)
  try {
    const info = db
      .prepare('DELETE FROM items WHERE collection = ? AND id = ?')
      .run(collection, itemId)
    return info.changes === 1
  } finally {
    db.close()
  }
}

function removeWithRetry(file: string): void {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(file, { force: true })
      return
    } catch {
      // A still-open handle can keep the file busy briefly; retry, then move on.
    }
  }
}

/** Removes a site's database file and its WAL sidecars. */
export function deleteSiteData(uploadId: string): void {
  if (!UPLOAD_ID_RE.test(uploadId)) return
  const base = dbPathFor(uploadId)
  removeWithRetry(base)
  removeWithRetry(`${base}-wal`)
  removeWithRetry(`${base}-shm`)
}

/**
 * Deletes database files that no longer belong to any upload, skipping recent
 * files so a database created concurrently is never removed.
 */
export function reconcileSiteData(
  validUploadIds: string[],
  graceMs: number = SITE_DATA_RETIRE_GRACE_MS
): void {
  if (!existsSync(SITES_DIR)) return
  const valid = new Set(validUploadIds)
  for (const name of readdirSync(SITES_DIR)) {
    const match = SITE_FILE_RE.exec(name)
    if (!match || valid.has(match[1])) continue
    const target = join(SITES_DIR, name)
    try {
      if (Date.now() - statSync(target).mtimeMs < graceMs) continue
    } catch {
      continue
    }
    removeWithRetry(target)
  }
}
