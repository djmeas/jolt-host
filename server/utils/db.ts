import Database from 'better-sqlite3'
import { join, dirname } from 'path'
import { mkdirSync, existsSync } from 'fs'
import { randomUUID } from 'crypto'

const STORAGE_DIR = process.env.NODE_ENV === 'test' || process.env.JOLT_TEST_MODE === '1'
  ? join(process.cwd(), 'test', 'tmp-storage')
  : join(process.cwd(), 'storage')
const DB_PATH = process.env.NODE_ENV === 'test' || process.env.JOLT_TEST_MODE === '1'
  ? join(process.cwd(), 'test', 'tmp-data', 'jolt.db')
  : join(process.cwd(), 'data', 'jolt.db')

let db: ReturnType<typeof Database> | null = null

/**
 * Adds a column only when absent. Concurrent test workers share one DB file, so
 * the existence check and the ALTER are not atomic; a duplicate-column error
 * means another worker won the race and the desired state is already in place.
 */
function addColumnIfMissing(table: string, column: string, definition: string): void {
  const database = db!
  const exists = (database.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(column) as { '1': number } | undefined) != null
  if (exists) return
  try {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  } catch (err) {
    if (!String((err as Error).message).includes('duplicate column name')) throw err
  }
}

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
    addColumnIfMissing('uploads', 'password_hash', 'TEXT')
    addColumnIfMissing('uploads', 'owner_token', 'TEXT')
    addColumnIfMissing('uploads', 'expires_at', 'TEXT')
    addColumnIfMissing('uploads', 'title', 'TEXT')
    addColumnIfMissing('uploads', 'data_enabled', 'INTEGER NOT NULL DEFAULT 0')

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
    addColumnIfMissing('users', 'ai_build_enabled', 'INTEGER NOT NULL DEFAULT 0')

    addColumnIfMissing('uploads', 'user_id', 'TEXT REFERENCES users(id) ON DELETE SET NULL')
    db.exec(`CREATE INDEX IF NOT EXISTS idx_uploads_user_id ON uploads(user_id)`)

    db.exec(`
      CREATE TABLE IF NOT EXISTS api_tokens (
        id TEXT PRIMARY KEY,
        nickname TEXT UNIQUE NOT NULL,
        token_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_api_tokens_nickname ON api_tokens(nickname);
    `)

    // Link tokens to the account that owns them, so uploads can be attributed.
    addColumnIfMissing('api_tokens', 'user_id', 'TEXT REFERENCES users(id) ON DELETE SET NULL')
    db.exec(`CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id ON api_tokens(user_id)`)

    // AI Builder: one private workspace per account and its per-turn cost rows.
    // Foreign keys are documentation only here (no connection-level pragma is
    // enabled), so account cleanup explicitly calls deleteAiDataForUser().
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        base_url TEXT,
        api_key_cipher TEXT,
        api_key_nonce TEXT,
        api_key_tag TEXT,
        model TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ai_workspaces (
        user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        current_generation TEXT,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        entry_file TEXT NOT NULL DEFAULT 'index.html',
        attached_upload_id TEXT,
        attached_slug TEXT,
        attached_entry_point TEXT,
        snapshot_dir TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (
          (attached_upload_id IS NULL AND attached_slug IS NULL
            AND attached_entry_point IS NULL AND snapshot_dir IS NULL)
          OR
          (attached_upload_id IS NOT NULL AND attached_slug IS NOT NULL
            AND attached_entry_point IS NOT NULL AND snapshot_dir IS NOT NULL)
        )
      );

      CREATE TABLE IF NOT EXISTS ai_messages (
        id TEXT PRIMARY KEY NOT NULL,
        turn_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL CHECK (length(CAST(content AS BLOB)) <= 16384),
        model TEXT,
        input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
        output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
        duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
        status TEXT NOT NULL CHECK (status IN ('pending', 'ok', 'error')),
        error_code TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (turn_id, role),
        CHECK (role = 'assistant' OR
          (model IS NULL AND input_tokens IS NULL
            AND output_tokens IS NULL AND duration_ms IS NULL))
      );
      CREATE INDEX IF NOT EXISTS idx_ai_messages_user_session_created
        ON ai_messages(user_id, session_id, created_at, id);
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
  userId: string | null = null,
  title: string | null = null
): void {
  const database = getDb()
  database.prepare(
    'INSERT INTO uploads (id, slug, entry_point, password_hash, owner_token, created_at, expires_at, user_id, title) VALUES (?, ?, ?, ?, ?, datetime(\'now\'), ?, ?, ?)'
  ).run(id, slug, entryPoint, passwordHash, ownerToken, expiresAt, userId, title)
}

export function updatePasswordBySlugAndOwnerToken(slug: string, ownerToken: string, passwordHash: string): boolean {
  const database = getDb()
  const info = database.prepare(
    `UPDATE uploads
     SET password_hash = ?,
         data_enabled = CASE WHEN ? IS NULL THEN 0 ELSE data_enabled END
     WHERE slug = ? AND owner_token = ?`
  ).run(passwordHash, passwordHash, slug, ownerToken)
  return info.changes === 1
}

export function updateExpirationBySlugAndOwnerToken(slug: string, ownerToken: string, expiresAt: string | null): boolean {
  const database = getDb()
  const info = database.prepare(
    'UPDATE uploads SET expires_at = ? WHERE slug = ? AND owner_token = ?'
  ).run(expiresAt, slug, ownerToken)
  return info.changes === 1
}

/**
 * Switches a site's entry point only when it still matches the value observed
 * before preparation, ownership is unchanged when supplied, and the row has not
 * expired. The affected-row count is the publication switch.
 */
export function updateEntryPointIfUnchanged(
  slug: string,
  expectedEntryPoint: string,
  newEntryPoint: string,
  expectedUploadId?: string,
  expectedUserId?: string | null
): boolean {
  const database = getDb()
  const conditions = [
    'slug = ?',
    'entry_point = ?',
    "(expires_at IS NULL OR datetime(expires_at) > datetime('now'))",
  ]
  const params: (string | null)[] = [newEntryPoint, slug, expectedEntryPoint]
  if (expectedUploadId !== undefined) {
    conditions.push('id = ?')
    params.push(expectedUploadId)
  }
  if (expectedUserId !== undefined) {
    conditions.push('user_id IS ?')
    params.push(expectedUserId)
  }
  const info = database
    .prepare(`UPDATE uploads SET entry_point = ? WHERE ${conditions.join(' AND ')}`)
    .run(...params)
  return info.changes === 1
}

/** Returns slug/entry_point for every upload; used to reconcile stored content. */
export function getAllUploadEntryPoints(): { slug: string; entry_point: string }[] {
  const database = getDb()
  return database.prepare('SELECT slug, entry_point FROM uploads').all() as { slug: string; entry_point: string }[]
}

export type UserRow = {
  id: string
  name: string
  email: string
  password_hash: string
  upload_max_bytes: number | null
  never_expire: number
  ai_build_enabled: number
  created_at: string
  updated_at: string
}

export type UploadRow = { id: string; slug: string; entry_point: string; password_hash: string | null; owner_token: string | null; created_at: string; expires_at: string | null; user_id: string | null; title: string | null; data_enabled: number }

export function findUploadBySlug(slug: string): UploadRow | undefined {
  const database = getDb()
  const row = database.prepare('SELECT id, slug, entry_point, password_hash, owner_token, created_at, expires_at, user_id, title, data_enabled FROM uploads WHERE slug = ?').get(slug) as UploadRow | undefined
  return row
}

/** Returns the immutable id of every upload; used to reconcile per-site data files. */
export function getAllUploadIds(): string[] {
  const database = getDb()
  const rows = database.prepare('SELECT id FROM uploads').all() as { id: string }[]
  return rows.map((r) => r.id)
}

/**
 * Enables the data API only while the row exists, still has a password, and is
 * unexpired. The predicate is part of the statement, so a password cleared (or
 * an expiration applied) between the ownership check and this update cannot be
 * raced into an unprotected site having data enabled. Returns false when no row
 * matched.
 */
export function enableDataBySlug(slug: string): boolean {
  const database = getDb()
  const info = database.prepare(
    `UPDATE uploads SET data_enabled = 1
     WHERE slug = ?
       AND password_hash IS NOT NULL
       AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))`
  ).run(slug)
  return info.changes === 1
}

/** Disables the data API. Records are retained when data is disabled. */
export function disableDataBySlug(slug: string): boolean {
  const database = getDb()
  const info = database.prepare('UPDATE uploads SET data_enabled = 0 WHERE slug = ?').run(slug)
  return info.changes === 1
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

export function deleteUploadBySlugAndOwnerToken(slug: string, ownerToken: string): boolean {
  const database = getDb()
  const info = database.prepare('DELETE FROM uploads WHERE slug = ? AND owner_token = ?').run(slug, ownerToken)
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
  title: string | null
  data_enabled: boolean
  user_id: string | null
}

export function getAllUploads(): UploadListItem[] {
  const database = getDb()
  const rows = database
    .prepare(
      `SELECT id, slug, entry_point, created_at, expires_at, title, data_enabled, user_id,
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
    title: r.title,
    data_enabled: r.data_enabled === 1,
    user_id: r.user_id,
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
      `SELECT id, slug, entry_point, created_at, expires_at, title, data_enabled, user_id,
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
    title: r.title,
    data_enabled: r.data_enabled === 1,
    user_id: r.user_id,
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
  // Clearing the password also disables the data API (records are retained).
  const info = database.prepare(
    `UPDATE uploads
     SET password_hash = ?,
         data_enabled = CASE WHEN ? IS NULL THEN 0 ELSE data_enabled END
     WHERE slug = ?`
  ).run(passwordHash, passwordHash, slug)
  return info.changes === 1
}

// API tokens
export type ApiTokenRow = { id: string; nickname: string; token_hash: string; created_at: string; user_id: string | null }

export type ApiTokenListItem = {
  id: string
  nickname: string
  created_at: string
  user_id: string | null
  owner_name: string | null
  owner_email: string | null
}

export function insertApiToken(id: string, nickname: string, tokenHash: string, userId: string | null = null): void {
  const database = getDb()
  database.prepare(
    'INSERT INTO api_tokens (id, nickname, token_hash, created_at, user_id) VALUES (?, ?, ?, datetime(\'now\'), ?)'
  ).run(id, nickname, tokenHash, userId)
}

export function findApiTokenByNickname(nickname: string): ApiTokenRow | undefined {
  const database = getDb()
  return database.prepare(
    'SELECT id, nickname, token_hash, created_at, user_id FROM api_tokens WHERE nickname = ?'
  ).get(nickname) as ApiTokenRow | undefined
}

export function getAllApiTokens(): ApiTokenListItem[] {
  const database = getDb()
  return database.prepare(
    `SELECT t.id, t.nickname, t.created_at, t.user_id,
       u.name AS owner_name, u.email AS owner_email
     FROM api_tokens t
     LEFT JOIN users u ON u.id = t.user_id
     ORDER BY t.created_at DESC`
  ).all() as ApiTokenListItem[]
}

export function getApiTokensByUserId(userId: string): { id: string; nickname: string; created_at: string }[] {
  const database = getDb()
  const rows = database.prepare(
    'SELECT id, nickname, created_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC'
  ).all(userId) as { id: string; nickname: string; created_at: string }[]
  return rows
}

export function deleteApiTokenByNickname(nickname: string): boolean {
  const database = getDb()
  const info = database.prepare('DELETE FROM api_tokens WHERE nickname = ?').run(nickname)
  return info.changes === 1
}

/** Deletes a token only when it belongs to the given user; callers treat false as "not found / not yours". */
export function deleteApiTokenByNicknameAndUserId(nickname: string, userId: string): boolean {
  const database = getDb()
  const info = database.prepare('DELETE FROM api_tokens WHERE nickname = ? AND user_id = ?').run(nickname, userId)
  return info.changes === 1
}

export function deleteApiTokensByUserId(userId: string): void {
  const database = getDb()
  database.prepare('DELETE FROM api_tokens WHERE user_id = ?').run(userId)
}

export function findApiTokenByHash(tokenHash: string): ApiTokenRow | undefined {
  const database = getDb()
  return database.prepare(
    'SELECT id, nickname, token_hash, created_at, user_id FROM api_tokens WHERE token_hash = ?'
  ).get(tokenHash) as ApiTokenRow | undefined
}

// Users
export function insertUser(id: string, name: string, email: string, passwordHash: string, aiBuildEnabled = false): void {
  const database = getDb()
  database.prepare(
    'INSERT INTO users (id, name, email, password_hash, ai_build_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'), datetime(\'now\'))'
  ).run(id, name, email, passwordHash, aiBuildEnabled ? 1 : 0)
}

export function findUserByEmail(email: string): UserRow | null {
  const database = getDb()
  const row = database.prepare(
    'SELECT id, name, email, password_hash, upload_max_bytes, never_expire, ai_build_enabled, created_at, updated_at FROM users WHERE email = ?'
  ).get(email) as UserRow | undefined
  return row ?? null
}

export function findUserById(id: string): UserRow | null {
  const database = getDb()
  const row = database.prepare(
    'SELECT id, name, email, password_hash, upload_max_bytes, never_expire, ai_build_enabled, created_at, updated_at FROM users WHERE id = ?'
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

export function updateUserAiBuild(id: string, enabled: boolean): void {
  getDb().prepare('UPDATE users SET ai_build_enabled = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(enabled ? 1 : 0, id)
}

export function updateUserNameEmail(id: string, name: string, email: string): void {
  const database = getDb()
  database.prepare(
    'UPDATE users SET name = ?, email = ?, updated_at = datetime(\'now\') WHERE id = ?'
  ).run(name, email, id)
}

export function deleteUser(id: string): void {
  const database = getDb()
  // Revoke the account's API tokens so a deleted user leaves no working credential.
  database.prepare('DELETE FROM api_tokens WHERE user_id = ?').run(id)
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
    'SELECT id, name, email, upload_max_bytes, never_expire, ai_build_enabled, created_at, updated_at FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?'
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
    'SELECT id, slug, entry_point, password_hash, owner_token, created_at, expires_at, user_id, title, data_enabled FROM uploads WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(userId, l, offset) as UploadRow[]
  return { items: rows, total }
}

export type AiSettingsRow = {
  id: number
  base_url: string | null
  api_key_cipher: string | null
  api_key_nonce: string | null
  api_key_tag: string | null
  model: string | null
  updated_at: string
}

export function getAiSettings(): AiSettingsRow | null {
  return getDb().prepare('SELECT * FROM ai_settings WHERE id = 1').get() as AiSettingsRow | undefined ?? null
}

/** Writes a complete snapshot atomically; only the settings service supplies encrypted keys. */
export function setAiSettings(settings: Omit<AiSettingsRow, 'id' | 'updated_at'>): void {
  getDb().prepare(`
    INSERT INTO ai_settings (id, base_url, api_key_cipher, api_key_nonce, api_key_tag, model, updated_at)
    VALUES (1, @base_url, @api_key_cipher, @api_key_nonce, @api_key_tag, @model, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET base_url = excluded.base_url,
      api_key_cipher = excluded.api_key_cipher, api_key_nonce = excluded.api_key_nonce,
      api_key_tag = excluded.api_key_tag, model = excluded.model, updated_at = excluded.updated_at
  `).run(settings)
}

// AI Builder workspaces and transcripts.
//
// The workspace row is the publication switch for a user's private generation
// directory: `current_generation` is a generated basename (never a path) and the
// compare-and-switch update below is the only way it changes. Transcript rows
// exist for honest UI state and cost visibility; they are other people's text
// (the user's and the model's), never instructions to this server.

/** Stored transcript text is byte-bounded so the table CHECK can never fail on legal input. */
export const AI_MESSAGE_CONTENT_MAX_BYTES = 16384

export type AiWorkspaceRow = {
  user_id: string
  session_id: string
  current_generation: string | null
  revision: number
  entry_file: string
  attached_upload_id: string | null
  attached_slug: string | null
  attached_entry_point: string | null
  snapshot_dir: string | null
  created_at: string
  updated_at: string
}

export type AiMessageRow = {
  id: string
  turn_id: string
  user_id: string
  session_id: string
  role: 'user' | 'assistant'
  content: string
  model: string | null
  input_tokens: number | null
  output_tokens: number | null
  duration_ms: number | null
  status: 'pending' | 'ok' | 'error'
  error_code: string | null
  created_at: string
}

/** Usage figures are provider-reported; absent or nonsense values stay null. */
export type AiTurnUsage = {
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
  durationMs: number | null
}

/** Attachment state a workspace may carry. `null` clears it; `undefined` leaves it alone. */
export type AiWorkspaceAttachment = {
  uploadId: string
  slug: string
  entryPoint: string
  snapshotDir: string
}

export type AiWorkspaceSwitch = {
  userId: string
  expectedRevision: number
  expectedGeneration: string | null
  generation: string | null
  entryFile: string
  attachment?: AiWorkspaceAttachment | null
  /** Omit to keep the current session; set to start a new one. */
  sessionId?: string
}

const AI_MESSAGE_COLUMNS =
  'id, turn_id, user_id, session_id, role, content, model, input_tokens, output_tokens, duration_ms, status, error_code, created_at'

/**
 * Truncates to a UTF-8 byte budget without splitting a code point, so stored
 * assistant/user text always satisfies the ai_messages byte-length CHECK.
 */
export function truncateUtf8Bytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let out = ''
  let bytes = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (bytes + size > maxBytes) break
    out += char
    bytes += size
  }
  return out
}

/** Fetches a workspace row without creating one; reads never allocate state. */
export function getAiWorkspace(userId: string): AiWorkspaceRow | null {
  const database = getDb()
  const row = database.prepare('SELECT * FROM ai_workspaces WHERE user_id = ?').get(userId) as AiWorkspaceRow | undefined
  return row ?? null
}

/**
 * Lazily creates the empty (revision 0, no generation) workspace for an existing
 * account. Returns null when the account row is gone, so a deleted account can
 * never be resurrected by a late request.
 */
export function getOrCreateAiWorkspace(userId: string): AiWorkspaceRow | null {
  const database = getDb()
  const exists = database.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)
  if (!exists) return null
  database.prepare('INSERT OR IGNORE INTO ai_workspaces (user_id, session_id) VALUES (?, ?)').run(userId, randomUUID())
  return getAiWorkspace(userId)
}

/**
 * Compare-and-switch of the workspace pointer: succeeds only while the revision
 * and generation still match what the caller read, the account still exists, and
 * the row is unexpired-agnostic (workspaces are not TTL-managed). One increment
 * of `revision` accompanies each accepted switch.
 */
export function compareAndSwitchAiWorkspace(input: AiWorkspaceSwitch): boolean {
  const database = getDb()
  const sets = [
    'current_generation = @generation',
    'entry_file = @entryFile',
    'revision = revision + 1',
    `updated_at = datetime('now')`,
  ]
  const params: Record<string, unknown> = {
    userId: input.userId,
    expectedRevision: input.expectedRevision,
    expectedGeneration: input.expectedGeneration,
    generation: input.generation,
    entryFile: input.entryFile,
  }
  if (input.sessionId !== undefined) {
    sets.push('session_id = @sessionId')
    params.sessionId = input.sessionId
  }
  if (input.attachment === null) {
    sets.push('attached_upload_id = NULL, attached_slug = NULL, attached_entry_point = NULL, snapshot_dir = NULL')
  } else if (input.attachment) {
    sets.push(
      'attached_upload_id = @attachUploadId, attached_slug = @attachSlug, attached_entry_point = @attachEntryPoint, snapshot_dir = @snapshotDir'
    )
    params.attachUploadId = input.attachment.uploadId
    params.attachSlug = input.attachment.slug
    params.attachEntryPoint = input.attachment.entryPoint
    params.snapshotDir = input.attachment.snapshotDir
  }
  const info = database.prepare(
    `UPDATE ai_workspaces SET ${sets.join(', ')}
     WHERE user_id = @userId
       AND revision = @expectedRevision
       AND current_generation IS @expectedGeneration
       AND EXISTS (SELECT 1 FROM users WHERE id = ai_workspaces.user_id)`
  ).run(params)
  return info.changes === 1
}

/**
 * Refreshes only the attached-site baseline after a successful builder
 * publication. It deliberately leaves `revision`, `current_generation`,
 * `session_id`, and the original `snapshot_dir` untouched: publishing does not
 * change the editable workspace, and the pre-edit snapshot must keep pointing at
 * the bytes observed when the site was attached.
 */
export function updateAiWorkspaceAttachedEntryPoint(
  userId: string,
  uploadId: string,
  entryPoint: string
): boolean {
  const database = getDb()
  const info = database.prepare(
    `UPDATE ai_workspaces SET attached_entry_point = ?, updated_at = datetime('now')
     WHERE user_id = ? AND attached_upload_id = ?`
  ).run(entryPoint, userId, uploadId)
  return info.changes === 1
}

/**
 * Inserts both pending rows of a turn before the provider call. Returns false
 * when the account row no longer exists (nothing is written in that case).
 */
export function insertAiTurnPending(input: {
  turnId: string
  userId: string
  sessionId: string
  userContent: string
}): boolean {
  const database = getDb()
  const insert = database.prepare(
    `INSERT INTO ai_messages (id, turn_id, user_id, session_id, role, content, status)
     SELECT ?, ?, ?, ?, ?, ?, 'pending' WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)`
  )
  const tx = database.transaction(() => {
    const user = insert.run(
      randomUUID(),
      input.turnId,
      input.userId,
      input.sessionId,
      'user',
      truncateUtf8Bytes(input.userContent, AI_MESSAGE_CONTENT_MAX_BYTES),
      input.userId
    )
    if (user.changes !== 1) return false
    insert.run(randomUUID(), input.turnId, input.userId, input.sessionId, 'assistant', '', input.userId)
    return true
  })
  return tx() as boolean
}

/**
 * Finalizes a successful turn. The workspace pointer switch (when requested) and
 * the transcript writes share one transaction: if the switch loses the CAS, or
 * the transcript rows are gone, nothing is committed and the old workspace
 * generation stays active. Staged files must already exist on disk.
 */
export function finalizeAiTurnSuccess(
  input: AiTurnUsage & {
    turnId: string
    userId: string
    summary: string
    workspace?: AiWorkspaceSwitch
  }
): boolean {
  const database = getDb()
  const updateAssistant = database.prepare(
    `UPDATE ai_messages
     SET content = @content, status = 'ok', model = @model,
         input_tokens = @inputTokens, output_tokens = @outputTokens, duration_ms = @durationMs
     WHERE turn_id = @turnId AND user_id = @userId AND role = 'assistant'`
  )
  const updateUser = database.prepare(
    `UPDATE ai_messages SET status = 'ok'
     WHERE turn_id = @turnId AND user_id = @userId AND role = 'user'`
  )
  const tx = database.transaction(() => {
    if (input.workspace && !compareAndSwitchAiWorkspace(input.workspace)) return false
    const info = updateAssistant.run({
      turnId: input.turnId,
      userId: input.userId,
      content: truncateUtf8Bytes(input.summary, AI_MESSAGE_CONTENT_MAX_BYTES),
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      durationMs: input.durationMs,
    })
    // A success response must never be returned without its transcript rows.
    if (info.changes !== 1) throw new Error('AI turn rows are missing')
    updateUser.run({ turnId: input.turnId, userId: input.userId })
    return true
  })
  return tx() as boolean
}

/**
 * Finalizes a failed turn: the assistant row carries a safe summary and code plus
 * whatever usage the provider did report, and both rows become `error` so later
 * prompt history excludes the turn.
 */
export function finalizeAiTurnError(
  input: AiTurnUsage & {
    turnId: string
    userId: string
    summary: string
    errorCode: string
  }
): boolean {
  const database = getDb()
  const updateAssistant = database.prepare(
    `UPDATE ai_messages
     SET content = @content, status = 'error', error_code = @errorCode, model = @model,
         input_tokens = @inputTokens, output_tokens = @outputTokens, duration_ms = @durationMs
     WHERE turn_id = @turnId AND user_id = @userId AND role = 'assistant'`
  )
  const updateUser = database.prepare(
    `UPDATE ai_messages SET status = 'error'
     WHERE turn_id = @turnId AND user_id = @userId AND role = 'user'`
  )
  const tx = database.transaction(() => {
    const info = updateAssistant.run({
      turnId: input.turnId,
      userId: input.userId,
      content: truncateUtf8Bytes(input.summary, AI_MESSAGE_CONTENT_MAX_BYTES),
      errorCode: input.errorCode,
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      durationMs: input.durationMs,
    })
    if (info.changes !== 1) return false
    updateUser.run({ turnId: input.turnId, userId: input.userId })
    return true
  })
  return tx() as boolean
}

/**
 * Newest `limit` transcript rows of one session, returned in deterministic
 * (created_at, id) order for display.
 */
export function getAiMessages(userId: string, sessionId: string, limit = 20): AiMessageRow[] {
  const database = getDb()
  const rows = database.prepare(
    `SELECT ${AI_MESSAGE_COLUMNS} FROM ai_messages
     WHERE user_id = ? AND session_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT ?`
  ).all(userId, sessionId, limit) as AiMessageRow[]
  return rows.reverse()
}

export type AiConversationTurn = {
  turnId: string
  userContent: string
  assistantContent: string
}

/**
 * Newest successful user/assistant pairs of one session, oldest first. Pending
 * and error turns are excluded: an interrupted attempt is history, not an
 * instruction to replay.
 */
export function getAiConversationTurns(userId: string, sessionId: string, maxPairs = 4): AiConversationTurn[] {
  const database = getDb()
  const rows = database.prepare(
    `SELECT ${AI_MESSAGE_COLUMNS} FROM ai_messages
     WHERE user_id = ? AND session_id = ? AND status = 'ok'
     ORDER BY created_at DESC, id DESC
     LIMIT ?`
  ).all(userId, sessionId, maxPairs * 2) as AiMessageRow[]

  const byTurn = new Map<string, AiMessageRow[]>()
  for (const row of rows) {
    const bucket = byTurn.get(row.turn_id)
    if (bucket) bucket.push(row)
    else byTurn.set(row.turn_id, [row])
  }

  const turns: AiConversationTurn[] = []
  for (const [turnId, group] of byTurn) {
    const user = group.find((row) => row.role === 'user')
    const assistant = group.find((row) => row.role === 'assistant')
    if (!user || !assistant) continue
    turns.push({ turnId, userContent: user.content, assistantContent: assistant.content })
  }
  return turns.slice(-maxPairs)
}

/**
 * Removes this account's transcript and workspace rows. Filesystem state is
 * removed by the workspace helper; callers surface a filesystem failure rather
 * than reporting a complete deletion.
 */
export function deleteAiDataForUser(userId: string): void {
  const database = getDb()
  const tx = database.transaction(() => {
    database.prepare('DELETE FROM ai_messages WHERE user_id = ?').run(userId)
    database.prepare('DELETE FROM ai_workspaces WHERE user_id = ?').run(userId)
  })
  tx()
}
