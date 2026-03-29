import Database from 'better-sqlite3'
import { join, dirname } from 'path'
import { mkdirSync, existsSync } from 'fs'

const STORAGE_DIR = process.env.NODE_ENV === 'test'
  ? join(process.cwd(), 'test', 'tmp-storage')
  : join(process.cwd(), 'storage')
const DB_PATH = process.env.NODE_ENV === 'test'
  ? join(process.cwd(), 'test', 'tmp-data', 'jolt.db')
  : join(process.cwd(), 'data', 'jolt.db')

let db: ReturnType<typeof Database> | null = null

function getDb(): Database.Database {
  if (!db) {
    const dir = dirname(DB_PATH)
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
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        upload_max_bytes INTEGER,
        never_expire INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    `)

    // check if user_id column exists on uploads, add if not
    const uploadsColumns = db.prepare("SELECT name FROM pragma_table_info('uploads')").all() as { name: string }[]
    if (!uploadsColumns.find(c => c.name === 'user_id')) {
      db.prepare("ALTER TABLE uploads ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE SET NULL").run()
      db.prepare("CREATE INDEX IF NOT EXISTS idx_uploads_user_id ON uploads(user_id)").run()
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS api_tokens (
        id TEXT PRIMARY KEY,
        nickname TEXT UNIQUE NOT NULL,
        token_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_api_tokens_nickname ON api_tokens(nickname);
    `)
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
  expiresAt: string | null = null,
  userId: string | null = null
): void {
  const database = getDb()
  database.prepare(
    'INSERT INTO uploads (id, slug, entry_point, password_hash, owner_token, created_at, expires_at, user_id) VALUES (?, ?, ?, ?, ?, datetime(\'now\'), ?, ?)'
  ).run(id, slug, entryPoint, passwordHash, ownerToken, expiresAt, userId)
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

export type UserRow = {
  id: string
  name: string
  email: string
  password_hash: string
  upload_max_bytes: number | null
  never_expire: number
  created_at: string
  updated_at: string
}

export type UploadRow = { id: string; slug: string; entry_point: string; password_hash: string | null; owner_token: string | null; created_at: string; expires_at: string | null; user_id: string | null }

export function findUploadBySlug(slug: string): UploadRow | undefined {
  const database = getDb()
  const row = database.prepare('SELECT id, slug, entry_point, password_hash, owner_token, created_at, expires_at, user_id FROM uploads WHERE slug = ?').get(slug) as UploadRow | undefined
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

export type UploadListItem = {
  id: string
  slug: string
  entry_point: string
  created_at: string
  expires_at: string | null
  has_password: boolean
}

export function getAllUploads(): UploadListItem[] {
  const database = getDb()
  const rows = database
    .prepare(
      `SELECT id, slug, entry_point, created_at, expires_at,
        CASE WHEN password_hash IS NOT NULL THEN 1 ELSE 0 END as has_password
       FROM uploads ORDER BY created_at DESC`
    )
    .all() as (UploadRow & { has_password: number })[]
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    entry_point: r.entry_point,
    created_at: r.created_at,
    expires_at: r.expires_at,
    has_password: r.has_password === 1,
  }))
}

export type UploadsFilter = {
  dateFrom?: string // ISO date
  dateTo?: string // ISO date
  hasPassword?: boolean // true = protected only, false = unprotected only, undefined = all
  page?: number
  limit?: number
}

export function getUploadsPaginated(filter: UploadsFilter = {}): {
  items: UploadListItem[]
  total: number
  page: number
  limit: number
} {
  const database = getDb()
  const page = Math.max(1, filter.page ?? 1)
  const limit = Math.min(100, Math.max(1, filter.limit ?? 20))
  const offset = (page - 1) * limit

  const conditions: string[] = []
  const params: (string | number)[] = []

  if (filter.dateFrom) {
    conditions.push('date(created_at) >= date(?)')
    params.push(filter.dateFrom)
  }
  if (filter.dateTo) {
    conditions.push('date(created_at) <= date(?)')
    params.push(filter.dateTo)
  }
  if (filter.hasPassword === true) {
    conditions.push('password_hash IS NOT NULL')
  } else if (filter.hasPassword === false) {
    conditions.push('password_hash IS NULL')
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const countRow = database
    .prepare(`SELECT COUNT(*) as n FROM uploads ${whereClause}`)
    .get(...params) as { n: number }
  const total = countRow.n

  const rows = database
    .prepare(
      `SELECT id, slug, entry_point, created_at, expires_at,
        CASE WHEN password_hash IS NOT NULL THEN 1 ELSE 0 END as has_password
       FROM uploads ${whereClause}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as (UploadRow & { has_password: number })[]

  const items = rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    entry_point: r.entry_point,
    created_at: r.created_at,
    expires_at: r.expires_at,
    has_password: r.has_password === 1,
  }))

  return { items, total, page, limit }
}

export function updateExpirationBySlug(slug: string, expiresAt: string | null): boolean {
  const database = getDb()
  const info = database.prepare('UPDATE uploads SET expires_at = ? WHERE slug = ?').run(expiresAt, slug)
  return info.changes === 1
}

export function updatePasswordBySlug(slug: string, passwordHash: string | null): boolean {
  const database = getDb()
  const info = database.prepare('UPDATE uploads SET password_hash = ? WHERE slug = ?').run(passwordHash, slug)
  return info.changes === 1
}

// API tokens
export type ApiTokenRow = { id: string; nickname: string; token_hash: string; created_at: string }

export function insertApiToken(id: string, nickname: string, tokenHash: string): void {
  const database = getDb()
  database.prepare(
    'INSERT INTO api_tokens (id, nickname, token_hash, created_at) VALUES (?, ?, ?, datetime(\'now\'))'
  ).run(id, nickname, tokenHash)
}

export function findApiTokenByNickname(nickname: string): ApiTokenRow | undefined {
  const database = getDb()
  return database.prepare(
    'SELECT id, nickname, token_hash, created_at FROM api_tokens WHERE nickname = ?'
  ).get(nickname) as ApiTokenRow | undefined
}

export function getAllApiTokens(): { id: string; nickname: string; created_at: string }[] {
  const database = getDb()
  const rows = database.prepare(
    'SELECT id, nickname, created_at FROM api_tokens ORDER BY created_at DESC'
  ).all() as ApiTokenRow[]
  return rows.map((r) => ({ id: r.id, nickname: r.nickname, created_at: r.created_at }))
}

export function deleteApiTokenByNickname(nickname: string): boolean {
  const database = getDb()
  const info = database.prepare('DELETE FROM api_tokens WHERE nickname = ?').run(nickname)
  return info.changes === 1
}

export function findApiTokenByHash(tokenHash: string): ApiTokenRow | undefined {
  const database = getDb()
  return database.prepare(
    'SELECT id, nickname, token_hash, created_at FROM api_tokens WHERE token_hash = ?'
  ).get(tokenHash) as ApiTokenRow | undefined
}

// Users
export function insertUser(id: string, name: string, email: string, passwordHash: string): void {
  const database = getDb()
  database.prepare(
    'INSERT INTO users (id, name, email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, datetime(\'now\'), datetime(\'now\'))'
  ).run(id, name, email, passwordHash)
}

export function findUserByEmail(email: string): UserRow | null {
  const database = getDb()
  const row = database.prepare(
    'SELECT id, name, email, password_hash, upload_max_bytes, never_expire, created_at, updated_at FROM users WHERE email = ?'
  ).get(email) as UserRow | undefined
  return row ?? null
}

export function findUserById(id: string): UserRow | null {
  const database = getDb()
  const row = database.prepare(
    'SELECT id, name, email, password_hash, upload_max_bytes, never_expire, created_at, updated_at FROM users WHERE id = ?'
  ).get(id) as UserRow | undefined
  return row ?? null
}

export function updateUserPassword(id: string, passwordHash: string): void {
  const database = getDb()
  database.prepare(
    'UPDATE users SET password_hash = ?, updated_at = datetime(\'now\') WHERE id = ?'
  ).run(passwordHash, id)
}

export function updateUserLimits(id: string, uploadMaxBytes: number | null, neverExpire: number): void {
  const database = getDb()
  database.prepare(
    'UPDATE users SET upload_max_bytes = ?, never_expire = ?, updated_at = datetime(\'now\') WHERE id = ?'
  ).run(uploadMaxBytes, neverExpire, id)
}

export function updateUserNameEmail(id: string, name: string, email: string): void {
  const database = getDb()
  database.prepare(
    'UPDATE users SET name = ?, email = ?, updated_at = datetime(\'now\') WHERE id = ?'
  ).run(name, email, id)
}

export function deleteUser(id: string): void {
  const database = getDb()
  database.prepare('DELETE FROM users WHERE id = ?').run(id)
}

export function getUsersPaginated(page: number, limit: number): { items: Omit<UserRow, 'password_hash'>[], total: number } {
  const database = getDb()
  const p = Math.max(1, page)
  const l = Math.min(100, Math.max(1, limit))
  const offset = (p - 1) * l
  const countRow = database.prepare('SELECT COUNT(*) as n FROM users').get() as { n: number }
  const total = countRow.n
  const rows = database.prepare(
    'SELECT id, name, email, upload_max_bytes, never_expire, created_at, updated_at FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(l, offset) as Omit<UserRow, 'password_hash'>[]
  return { items: rows, total }
}

export function getUploadsByUserId(userId: string, page: number, limit: number): { items: UploadRow[], total: number } {
  const database = getDb()
  const p = Math.max(1, page)
  const l = Math.min(100, Math.max(1, limit))
  const offset = (p - 1) * l
  const countRow = database.prepare('SELECT COUNT(*) as n FROM uploads WHERE user_id = ?').get(userId) as { n: number }
  const total = countRow.n
  const rows = database.prepare(
    'SELECT id, slug, entry_point, password_hash, owner_token, created_at, expires_at, user_id FROM uploads WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(userId, l, offset) as UploadRow[]
  return { items: rows, total }
}
