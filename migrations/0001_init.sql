-- Initial schema for jolt-host on Cloudflare D1

CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  entry_point TEXT NOT NULL,
  password_hash TEXT,
  owner_token TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_uploads_slug ON uploads(slug);

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  nickname TEXT UNIQUE NOT NULL,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_nickname ON api_tokens(nickname);
