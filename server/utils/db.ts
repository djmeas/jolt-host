import Database from 'better-sqlite3'
import { join } from 'path'
import { mkdirSync, existsSync } from 'fs'

const STORAGE_DIR = join(process.cwd(), 'storage')
const DB_PATH = join(process.cwd(), 'data', 'jolt.db')

let db: ReturnType<typeof Database> | null = null

function getDb(): Database.Database {
  if (!db) {
    const dir = join(process.cwd(), 'data')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    db = new Database(DB_PATH)
    db.exec(`
      CREATE TABLE IF NOT EXISTS uploads (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        entry_point TEXT NOT NULL,
        password_hash TEXT,
        owner_token TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_uploads_slug ON uploads(slug);
    `)
    const hasPasswordHash = (db.prepare("SELECT 1 FROM pragma_table_info('uploads') WHERE name = 'password_hash'").get() as { '1': number } | undefined) != null
    if (!hasPasswordHash) {
      db.exec(`ALTER TABLE uploads ADD COLUMN password_hash TEXT`)
    }
    const hasOwnerToken = (db.prepare("SELECT 1 FROM pragma_table_info('uploads') WHERE name = 'owner_token'").get() as { '1': number } | undefined) != null
    if (!hasOwnerToken) {
      db.exec(`ALTER TABLE uploads ADD COLUMN owner_token TEXT`)
    }
    const hasExpiresAt = (db.prepare("SELECT 1 FROM pragma_table_info('uploads') WHERE name = 'expires_at'").get() as { '1': number } | undefined) != null
    if (!hasExpiresAt) {
      db.exec(`ALTER TABLE uploads ADD COLUMN expires_at TEXT`)
    }
  }
  return db
}

export function getStorageDir(): string {
  if (!existsSync(STORAGE_DIR)) mkdirSync(STORAGE_DIR, { recursive: true })
  return STORAGE_DIR
}

export function getDbPath(): string {
  return DB_PATH
}

export function insertUpload(
  id: string,
  slug: string,
  entryPoint: string,
  passwordHash: string | null = null,
  ownerToken: string | null = null,
  expiresAt: string | null = null
): void {
  const database = getDb()
  database.prepare(
    'INSERT INTO uploads (id, slug, entry_point, password_hash, owner_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'), ?)'
  ).run(id, slug, entryPoint, passwordHash, ownerToken, expiresAt)
}

export function updatePasswordBySlugAndOwnerToken(slug: string, ownerToken: string, passwordHash: string): boolean {
  const database = getDb()
  const info = database.prepare(
    'UPDATE uploads SET password_hash = ? WHERE slug = ? AND owner_token = ?'
  ).run(passwordHash, slug, ownerToken)
  return info.changes === 1
}

export function updateExpirationBySlugAndOwnerToken(slug: string, ownerToken: string, expiresAt: string | null): boolean {
  const database = getDb()
  const info = database.prepare(
    'UPDATE uploads SET expires_at = ? WHERE slug = ? AND owner_token = ?'
  ).run(expiresAt, slug, ownerToken)
  return info.changes === 1
}

export type UploadRow = { id: string; slug: string; entry_point: string; password_hash: string | null; owner_token: string | null; created_at: string; expires_at: string | null }

export function findUploadBySlug(slug: string): UploadRow | undefined {
  const database = getDb()
  const row = database.prepare('SELECT id, slug, entry_point, password_hash, owner_token, created_at, expires_at FROM uploads WHERE slug = ?').get(slug) as UploadRow | undefined
  return row
}

/** Returns slugs of uploads whose expires_at is set and in the past. */
export function getExpiredUploadSlugs(): string[] {
  const database = getDb()
  const rows = database.prepare(
    "SELECT slug FROM uploads WHERE expires_at IS NOT NULL AND datetime(expires_at) < datetime('now')"
  ).all() as { slug: string }[]
  return rows.map((r) => r.slug)
}

export function deleteUploadBySlug(slug: string): boolean {
  const database = getDb()
  const info = database.prepare('DELETE FROM uploads WHERE slug = ?').run(slug)
  return info.changes === 1
}

export function slugExists(slug: string): boolean {
  return findUploadBySlug(slug) !== undefined
}
