import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { getAiSettings, setAiSettings } from '~/server/utils/db'

let derivedKey: { secret: string; key: Buffer } | undefined

function encryptionKey(): Buffer {
  const secret = process.env.JOLT_ADMIN_SECRET ?? process.env.JOLT_VIEW_SECRET ?? 'jolt-admin-default-change-in-production'
  if (!derivedKey || derivedKey.secret !== secret) {
    derivedKey = { secret, key: scryptSync(secret, 'jolt-ai-settings-v1', 32) }
  }
  return derivedKey.key
}

/** Absolute HTTPS, with HTTP permitted only for local providers. */
export function resolveAiChatUrl(raw: string): string | null {
  let url: URL
  try { url = new URL(raw) } catch { return null }
  const host = url.hostname.toLowerCase()
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null
  if (url.username || url.password || url.search || url.hash) return null
  const path = url.pathname.replace(/\/+$/, '')
  const suffix = path.endsWith('/chat/completions') ? path : `${path}/chat/completions`
  return `${url.protocol}//${url.host}${suffix}`
}

/** Server-only effective values; admin overrides are resolved field by field. */
export function resolveAiSettings(env: NodeJS.ProcessEnv = process.env) {
  const stored = getAiSettings()
  let adminKey: string | null = null
  if (stored?.api_key_cipher && stored.api_key_nonce && stored.api_key_tag) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(stored.api_key_nonce, 'base64url'))
      decipher.setAuthTag(Buffer.from(stored.api_key_tag, 'base64url'))
      adminKey = Buffer.concat([decipher.update(Buffer.from(stored.api_key_cipher, 'base64url')), decipher.final()]).toString('utf8')
    } catch {
      // A changed secret or tampered ciphertext fails closed, without logging secrets.
      adminKey = ''
    }
  }
  const baseUrl = stored?.base_url ?? (env.JOLT_AI_BASE_URL ?? '').trim()
  const model = stored?.model ?? (env.JOLT_AI_MODEL ?? '').trim()
  const apiKey = adminKey ?? (env.JOLT_AI_API_KEY ?? '').trim()
  const source: 'admin' | 'env' | 'none' = stored?.base_url || stored?.model || stored?.api_key_cipher
    ? 'admin' : baseUrl || model || apiKey ? 'env' : 'none'
  return { baseUrl, model, apiKey, source }
}

/** The only settings representation permitted in an admin response. */
export function getAdminAiSettings() {
  const { baseUrl, model, apiKey, source } = resolveAiSettings()
  const enabled = process.env.ENABLE_AI_BUILDER !== 'false'
  return {
    available: enabled && !!apiKey && !!model && !!resolveAiChatUrl(baseUrl),
    source,
    base_url: baseUrl || null,
    model: model || null,
    has_key: !!apiKey,
    key_hint: apiKey.length > 4 ? apiKey.slice(-4) : null,
    ai_build_enabled_global: enabled,
  }
}

/** Null/omitted leaves a field alone; an empty string removes the admin override. */
export function updateAiSettings(input: { base_url?: string | null; api_key?: string | null; model?: string | null }): void {
  const stored = getAiSettings()
  const next = {
    base_url: stored?.base_url ?? null,
    model: stored?.model ?? null,
    api_key_cipher: stored?.api_key_cipher ?? null,
    api_key_nonce: stored?.api_key_nonce ?? null,
    api_key_tag: stored?.api_key_tag ?? null,
  }
  if (typeof input.base_url === 'string') next.base_url = input.base_url.trim() || null
  if (typeof input.model === 'string') next.model = input.model.trim() || null
  if (typeof input.api_key === 'string') {
    const key = input.api_key.trim()
    if (key) {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', encryptionKey(), nonce)
      next.api_key_cipher = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]).toString('base64url')
      next.api_key_nonce = nonce.toString('base64url')
      next.api_key_tag = cipher.getAuthTag().toString('base64url')
    } else {
      next.api_key_cipher = next.api_key_nonce = next.api_key_tag = null
    }
  }
  setAiSettings(next)
}
