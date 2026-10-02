import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createError } from 'h3'
import { getAiSettings, setAiSettings } from './db'
import type { AiSettingsRow } from './db'
import { getAdminAiSettings, resolveAiSettings, updateAiSettings } from './ai-settings'
import { resolveAiConfig } from './ai-builder'
import { createAdminSession } from './admin-auth'
import { closeHarness, startApp } from '../../test/helpers/ai-endpoints'

vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
// Route imports must follow the Nuxt auto-import global stubs above; static imports run too early.
vi.stubGlobal('createError', createError)
const empty = { base_url: null, model: null, api_key_cipher: null, api_key_nonce: null, api_key_tag: null }
let original: AiSettingsRow | null
beforeEach(() => {
  original = getAiSettings()
  setAiSettings(empty)
  vi.stubEnv('JOLT_AI_API_KEY', 'environment-key-5678')
  vi.stubEnv('JOLT_AI_BASE_URL', 'https://env.example/v1')
  vi.stubEnv('JOLT_AI_MODEL', 'env-model')
  vi.stubEnv('ENABLE_AI_BUILDER', 'true')
})
afterEach(async () => {
  setAiSettings(original ?? empty)
  vi.unstubAllEnvs()
  await closeHarness()
})

describe('admin AI settings', () => {
  it('never reveals an entire short key as a hint', () => {
    updateAiSettings({ api_key: 'abc' })
    expect(getAdminAiSettings()).toMatchObject({ has_key: true, key_hint: null })
  })

  it('encrypts keys at rest, masks responses, and resolves admin fields before environment fields', () => {
    const key = 'admin-private-key-1234'
    updateAiSettings({ api_key: key, base_url: 'https://admin.example/v1', model: 'admin-model' })
    const row = getAiSettings()!
    expect(JSON.stringify(row)).not.toContain(key)
    expect(Buffer.from(row.api_key_cipher!, 'base64url').toString('utf8')).not.toContain(key)
    expect(Buffer.from(row.api_key_nonce!, 'base64url')).toHaveLength(12)
    expect(Buffer.from(row.api_key_tag!, 'base64url')).toHaveLength(16)
    expect(resolveAiConfig()).toMatchObject({ available: true, config: { apiKey: key, baseUrl: 'https://admin.example/v1', model: 'admin-model' } })
    expect(getAdminAiSettings()).toEqual({ available: true, source: 'admin', base_url: 'https://admin.example/v1', model: 'admin-model', has_key: true, key_hint: '1234', ai_build_enabled_global: true })
    expect(JSON.stringify(getAdminAiSettings())).not.toContain(key)
    updateAiSettings({ api_key: 'replacement-key-9876' })
    expect(getAiSettings()!.api_key_nonce).not.toBe(row.api_key_nonce)
    expect(resolveAiSettings().apiKey).toBe('replacement-key-9876')
  })

  it('keeps null/omitted fields, clears individual overrides to env, and honors the global kill switch', () => {
    updateAiSettings({ api_key: 'admin-key-1234', model: 'admin-model' })
    updateAiSettings({ api_key: null, model: null })
    expect(resolveAiSettings()).toMatchObject({ apiKey: 'admin-key-1234', model: 'admin-model', baseUrl: 'https://env.example/v1' })
    updateAiSettings({ api_key: '' })
    expect(resolveAiSettings()).toMatchObject({ apiKey: 'environment-key-5678', model: 'admin-model' })
    updateAiSettings({ model: '', base_url: '' })
    expect(getAdminAiSettings()).toMatchObject({ source: 'env', available: true })
    vi.stubEnv('ENABLE_AI_BUILDER', 'false')
    expect(getAdminAiSettings()).toMatchObject({ available: false, ai_build_enabled_global: false })
    vi.stubEnv('JOLT_AI_API_KEY', '')
    vi.stubEnv('JOLT_AI_BASE_URL', '')
    vi.stubEnv('JOLT_AI_MODEL', '')
    expect(getAdminAiSettings()).toMatchObject({ source: 'none', available: false, has_key: false, key_hint: null })
  })

  it('fails closed on modified ciphertext or a changed encryption secret', () => {
    vi.stubEnv('JOLT_ADMIN_SECRET', 'first-secret')
    updateAiSettings({ api_key: 'private-key-1234' })
    vi.stubEnv('JOLT_ADMIN_SECRET', 'different-secret')
    expect(resolveAiConfig()).toEqual({ available: false, reason: 'ai_key_missing' })
    vi.stubEnv('JOLT_ADMIN_SECRET', 'first-secret')
    const stored = getAiSettings()!
    setAiSettings({ ...stored, api_key_tag: Buffer.alloc(16).toString('base64url') })
    expect(resolveAiConfig()).toEqual({ available: false, reason: 'ai_key_missing' })
  })

  it('requires admin authentication and never returns the provider key through GET or PUT', async () => {
    const get = await startApp((await import('../api/admin/ai/settings.get')).default)
    const put = await startApp((await import('../api/admin/ai/settings.put')).default)
    expect((await fetch(get)).status).toBe(401)
    expect((await fetch(put, { method: 'PUT', body: '{}' })).status).toBe(401)
    const cookie = `jolt_admin=${createAdminSession().value}`
    const key = 'endpoint-secret-key-4321'
    const saved = await fetch(put, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ api_key: key, model: 'admin-model' }) })
    expect(saved.status).toBe(200)
    expect(saved.headers.get('cache-control')).toBe('no-store')
    const savedText = await saved.text()
    expect(savedText).not.toContain(key)
    expect(JSON.parse(savedText)).toMatchObject({ key_hint: '4321', model: 'admin-model', available: true })
    const response = await fetch(get, { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(savedText)
  })

  it('rejects invalid URL/model/type without partially persisting any settings', async () => {
    const put = await startApp((await import('../api/admin/ai/settings.put')).default)
    const cookie = `jolt_admin=${createAdminSession().value}`
    for (const invalid of [
      { base_url: 'http://public.example/v1' }, { base_url: '/v1' },
      { base_url: 'https://user:secret@example.com/v1' }, { base_url: 'https://example.com/v1?key=secret' },
      { base_url: 'https://example.com/v1#fragment' }, { model: '   ' }, { model: 'x'.repeat(201) }, { model: 42 },
    ]) {
      const response = await fetch(put, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ api_key: 'must-not-persist', ...invalid }) })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ data: { code: 'invalid_request' } })
      expect(getAiSettings()).toMatchObject(empty)
    }
  })
})
