import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { readFileSync, existsSync, rmSync, mkdirSync, writeFileSync, readdirSync, symlinkSync } from 'fs'
import { join } from 'path'
import http from 'node:http'
import { createWebSession } from '~/server/utils/web-session'
import { MAX_COLLECTIONS, MAX_RECORD_BYTES } from '~/server/utils/site-data'
import { DATA_BODY_MAX_BYTES } from '~/server/utils/data-api'
import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import archiver from 'archiver'
import { createHash } from 'crypto'
import type { AiWorkspaceRow, AiMessageRow, UploadRow } from '~/server/utils/db'
import { createApp, createRouter, toNodeListener, eventHandler } from 'h3'
import * as workspace from '~/server/utils/ai-workspace'
import * as content from '~/server/utils/upload-content'
import * as turnstile from '~/server/utils/turnstile'
import { spawnSync } from 'node:child_process'

const FIXTURES = join(process.cwd(), 'test', 'fixtures')
const SITE_BASE_HOSTNAME = 'sites.localhost'
const DATA_DIR = join(process.cwd(), 'test', 'tmp-data')
const SITE_DB_DIR = join(DATA_DIR, 'sites')

function fixture(name: string): Buffer {
  return readFileSync(join(FIXTURES, name))
}

function toBlob(data: Buffer): Blob {
  return new Blob([new Uint8Array(data)])
}

function uploadForm(name: string, extra: Record<string, string> = {}): FormData {
  const form = new FormData()
  form.append('file', toBlob(fixture(name)), name)
  for (const [k, v] of Object.entries(extra)) form.append(k, v)
  return form
}

function replaceForm(name: string, extra: Record<string, string> = {}): FormData {
  return uploadForm(name, extra)
}

async function readJson<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T
}

// Base URL for the running server - set by global setup
function getBaseUrl() {
  try {
    const { readFileSync } = require('fs')
    const { join } = require('path')
    const env = JSON.parse(readFileSync(join(process.cwd(), 'test', '.integration-env.json'), 'utf-8'))
    return env.JOLT_TEST_URL
  } catch {
    return process.env.JOLT_TEST_URL || 'http://127.0.0.1:3847'
  }
}

function serverPort(): string {
  return new URL(getBaseUrl()).port || '80'
}

/**
 * Raw HTTP request against the test server. The app and hosted-site origins
 * share one loopback listener, so the origin boundary is exercised by sending
 * the real `Host` header (undici ignores an overridden Host, therefore node:http).
 */
async function rawRequest(options: {
  method?: string
  path: string
  hostHeader: string
  headers?: Record<string, string>
  body?: string
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string; bytes: Buffer }> {
  const url = new URL(getBaseUrl())
  type RawResult = { status: number; headers: http.IncomingHttpHeaders; body: string; bytes: Buffer }
  // Manual resolvers rather than Promise.withResolvers: the project supports
  // Node 20, where that helper does not exist yet.
  let settle: (value: RawResult) => void = () => {}
  let fail: (reason: unknown) => void = () => {}
  const settled = new Promise<RawResult>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  const request = http.request(
    {
      host: url.hostname,
      port: Number(url.port || 80),
      method: options.method ?? 'GET',
      path: options.path,
      setHost: false,
      headers: { host: options.hostHeader, ...options.headers },
    },
    (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () =>
        settle({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          bytes: Buffer.concat(chunks),
        })
      )
    }
  )
  request.on('error', fail)
  if (options.body !== undefined) request.write(options.body)
  request.end()
  return settled
}

type SiteResponse = {
  status: number
  headers: Headers
  cookies: string[]
  text: () => Promise<string>
  json: <T = unknown>() => Promise<T>
}

function toSiteResponse(raw: {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}): SiteResponse {
  const headers = new Headers()
  for (const [key, value] of Object.entries(raw.headers)) {
    if (key === 'set-cookie' || value === undefined) continue
    if (Array.isArray(value)) for (const item of value) headers.append(key, item)
    else headers.append(key, String(value))
  }
  return {
    status: raw.status,
    headers,
    cookies: raw.headers['set-cookie'] ?? [],
    text: async () => raw.body,
    json: async <T,>() => JSON.parse(raw.body) as T,
  }
}

function siteOrigin(slug: string): string {
  return `http://${slug}.${SITE_BASE_HOSTNAME}:${serverPort()}`
}

function cookieValue(response: SiteResponse, name: string): string | null {
  for (const raw of response.cookies) {
    const [pair] = raw.split(';')
    const separator = pair.indexOf('=')
    if (separator > 0 && pair.slice(0, separator).trim() === name) {
      return pair.slice(separator + 1)
    }
  }
  return null
}

function cookieHeader(...values: (string | null | undefined)[]): string {
  return values.filter((v): v is string => Boolean(v)).join('; ')
}

async function siteRequest(
  slug: string,
  path: string,
  options: {
    method?: string
    body?: string
    headers?: Record<string, string>
    cookie?: string
  } = {}
): Promise<SiteResponse> {
  const host = `${slug}.${SITE_BASE_HOSTNAME}:${serverPort()}`
  const headers: Record<string, string> = { origin: `http://${host}`, ...options.headers }
  if (options.cookie) headers.cookie = options.cookie
  const raw = await rawRequest({
    method: options.method ?? 'GET',
    path,
    hostHeader: host,
    headers,
    body: options.body,
  })
  return toSiteResponse(raw)
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value)
}

function dbFileFor(uploadId: string): string {
  return join(SITE_DB_DIR, `${uploadId}.sqlite`)
}

// Runs once after every describe in this file has finished.
afterAll(() => {
  if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true })
  const tmpStorage = join(process.cwd(), 'test', 'tmp-storage')
  if (existsSync(tmpStorage)) rmSync(tmpStorage, { recursive: true })
})

describe('upload API integration', () => {
  let cookie: string
  let userCookie: string
  let adminCookie: string
  const email = `test-${randomUUID()}@example.com`
  const password = 'test-password-123'
  let userId: string

  beforeAll(async () => {
    const { value } = createWebSession()
    cookie = `jolt_web=${value}`
    const adminLogin = await fetch(`${getBaseUrl()}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-admin-password' }),
    })
    expect(adminLogin.status).toBe(200)
    adminCookie = adminLogin.headers.get('set-cookie')?.split(';')[0] ?? ''
    const createdUser = await fetch(`${getBaseUrl()}/api/admin/users`, {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test User', email, password }),
    })
    expect(createdUser.status).toBe(200)
    userId = (await createdUser.json()).id
    const login = await fetch(`${getBaseUrl()}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    expect(login.status).toBe(200)
    userCookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
  })

  it('uploads HTML file and returns slug, canonical url, entry_point, owner_token', async () => {
    const html = readFileSync(join(FIXTURES, 'dummy.html'))
    const form = new FormData()
    form.append('file', new Blob([html], { type: 'text/html' }), 'dummy.html')

    const res = await fetch(`${getBaseUrl()}/api/upload`, {
      method: 'POST',
      body: form,
      headers: { Cookie: userCookie },
    })
    const data = (await res.json()) as Record<string, string>

    expect(res.ok).toBe(true)
    expect(data).toMatchObject({
      slug: expect.any(String),
      url: expect.stringMatching(
        new RegExp(`^http://[a-z0-9-]+\\.${SITE_BASE_HOSTNAME}:\\d+/$`)
      ),
      entry_point: expect.stringContaining('index.html'),
      owner_token: expect.any(String),
    })
    expect(data).not.toHaveProperty('url_with_owner_token')
    expect(data.slug!.length).toBeGreaterThan(0)

    // The app origin redirects to the canonical hosted origin.
    const legacy = await fetch(`${getBaseUrl()}/view/${data.slug}`, { redirect: 'manual' })
    expect(legacy.status).toBe(302)
    expect(legacy.headers.get('location')).toBe(data.url)

    // Uploaded content is served only from the hosted origin.
    const page = await siteRequest(data.slug!, '/')
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('<title>Dummy Test Site</title>')

    const asset = await siteRequest(data.slug!, '/index.html')
    expect(asset.status).toBe(200)
    expect(await asset.text()).toContain('<h1>Dummy Test Site</h1>')
  })

  it('returns url_with_unlock on the hosted origin when a password is provided', async () => {
    const html = readFileSync(join(FIXTURES, 'dummy.html'))
    const form = new FormData()
    form.append('file', new Blob([html], { type: 'text/html' }), 'dummy.html')
    form.append('password', 'test-secret')

    const res = await fetch(`${getBaseUrl()}/api/upload`, {
      method: 'POST',
      body: form,
      headers: { Cookie: userCookie },
    })
    const data = (await res.json()) as Record<string, string>

    expect(res.ok).toBe(true)
    expect(data.url_with_unlock).toBeDefined()
    expect(data.url_with_unlock).not.toContain('password=')
    expect(data.url_with_unlock!.startsWith(data.url!)).toBe(true)

    // The hosted root redirects to Jolt's own unlock form.
    const locked = await siteRequest(data.slug!, '/')
    expect(locked.status).toBe(302)
    expect(locked.headers.get('location')).toBe('/_jolt/unlock')

    const form200 = await siteRequest(data.slug!, '/_jolt/unlock')
    expect(form200.status).toBe(200)
    expect(await form200.text()).toContain('type="password"')

    // The legacy app-origin unlock path redirects to the hosted form and never
    // sets a credential itself.
    const legacyUnlock = await fetch(`${getBaseUrl()}/view/${data.slug}/unlock`, {
      redirect: 'manual',
    })
    expect(legacyUnlock.status).toBe(302)
    expect(legacyUnlock.headers.get('location')).toBe(`${siteOrigin(data.slug!)}/_jolt/unlock`)
    expect(legacyUnlock.headers.get('set-cookie')).toBeNull()

    // The unlock link works and its token is not forwarded into uploaded HTML.
    const unlockToken = new URL(data.url_with_unlock!).searchParams.get('unlock')!
    const unlocked = await siteRequest(
      data.slug!,
      `/?unlock=${encodeURIComponent(unlockToken)}`
    )
    expect(unlocked.status).toBe(200)
    expect(await unlocked.text()).toContain('Dummy Test Site')
  })

  it('never forwards owner tokens, passwords, or unknown query credentials', async () => {
    const created = await fetch(`${getBaseUrl()}/api/upload`, {
      method: 'POST',
      body: uploadForm('dummy.html', { password: 'secret' }),
      headers: { Cookie: userCookie },
    }).then(readJson<Record<string, string>>)

    const legacy = await fetch(
      `${getBaseUrl()}/view/${created.slug}?owner_token=${created.owner_token}&password=secret&keep=1`,
      { redirect: 'manual' }
    )
    expect(legacy.status).toBe(302)
    expect(legacy.headers.get('location')).toBe(created.url)

    const legacyAsset = await fetch(
      `${getBaseUrl()}/view/${created.slug}/index.html?owner_token=${created.owner_token}&password=secret`,
      { redirect: 'manual' }
    )
    expect(legacyAsset.status).toBe(302)
    expect(legacyAsset.headers.get('location')).toBe(`${created.url}index.html`)
  })

  it('returns 401 when not authenticated', async () => {
    const html = readFileSync(join(FIXTURES, 'dummy.html'))
    const form = new FormData()
    form.append('file', new Blob([html], { type: 'text/html' }), 'dummy.html')

    const res = await fetch(`${getBaseUrl()}/api/upload`, {
      method: 'POST',
      body: form,
    })
    expect(res.status).toBe(401)
  })

  it('shows publishing forms only to logged-in users', async () => {
    for (const [path, formElement] of [['/paste', '<textarea'], ['/markdown', '<textarea']]) {
      const anonymous = await fetch(`${getBaseUrl()}${path}`)
      const anonymousHtml = await anonymous.text()
      expect(anonymousHtml, path).toContain('Log in to publish')
      expect(anonymousHtml, path).not.toContain(formElement)
      expect(anonymousHtml, path).not.toContain('Create an account')
      expect(anonymous.headers.get('set-cookie') ?? '', path).not.toContain('jolt_web')

      const registered = await fetch(`${getBaseUrl()}${path}`, { headers: { Cookie: userCookie } })
      const registeredHtml = await registered.text()
      expect(registeredHtml, path).toContain(formElement)
    }
  })

  it('shows a minimal landing to visitors and the uploader to logged-in users', async () => {
    const landingPageEnabled = process.env.ENABLE_LANDING_PAGE === 'true'
    const config = await fetch(`${getBaseUrl()}/api/config`).then(res => res.json())
    expect(config.landingPageEnabled).toBe(landingPageEnabled)

    const anonymous = await fetch(getBaseUrl())
    const anonymousHtml = await anonymous.text()
    if (landingPageEnabled) {
      expect(anonymousHtml).toContain('Log in to publish a static site.')
      expect(anonymousHtml).toContain('class="navbar"')
      const loggedIn = await fetch(getBaseUrl(), { headers: { Cookie: userCookie } }).then(res => res.text())
      expect(loggedIn).toContain('type="file"')
    } else {
      expect(anonymousHtml).toContain('alt="Jolt Host"')
      expect(anonymousHtml).toContain('src="/JoltSlashLogo.png"')
      expect(anonymousHtml).toContain('href="https://github.com/djmeas/jolt-host"')
      expect(anonymousHtml).not.toContain('class="navbar"')
      expect(anonymousHtml).not.toContain('class="footer"')
      expect(anonymousHtml).not.toContain('type="file"')
      const loggedIn = await fetch(getBaseUrl(), { headers: { Cookie: userCookie } }).then(res => res.text())
      expect(loggedIn).toContain('type="file"')
      expect(loggedIn).toContain('class="navbar"')
      expect(loggedIn).not.toContain('class="minimal-landing"')
      const logo = await fetch(`${getBaseUrl()}/JoltSlashLogo.png`)
      expect(logo.status).toBe(200)
      expect(logo.headers.get('content-type')).toContain('image/png')
    }
  })

  it('rejects web sessions but lets an API token publish on every publishing endpoint', async () => {
    const tokenResponse = await fetch(`${getBaseUrl()}/api/admin/tokens`, {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: `test-${randomUUID()}`, user_id: userId }),
    })
    expect(tokenResponse.status).toBe(200)
    const { token } = await tokenResponse.json()
    const requests = [
      { path: '/api/upload', body: () => {
        const form = new FormData()
        form.append('file', new Blob(['<h1>test</h1>'], { type: 'text/html' }), 'index.html')
        return form
      } },
      { path: '/api/paste', body: () => JSON.stringify({ html: '<h1>test</h1>' }) },
      { path: '/api/markdown', body: () => JSON.stringify({ markdown: '# test' }) },
    ]
    for (const { path, body } of requests) {
      // A bare web session cookie is not enough in restricted mode.
      const webOnly = await fetch(`${getBaseUrl()}${path}`, {
        method: 'POST',
        headers: { Cookie: cookie, ...(path !== '/api/upload' ? { 'Content-Type': 'application/json' } : {}) },
        body: body(),
      })
      expect(webOnly.status, `${path} with web session`).toBe(401)

      // An API token alone is enough.
      const tokenOnly = await fetch(`${getBaseUrl()}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, ...(path !== '/api/upload' ? { 'Content-Type': 'application/json' } : {}) },
        body: body(),
      })
      expect(tokenOnly.ok, `${path} with API token`).toBe(true)

      const withLogin = await fetch(`${getBaseUrl()}${path}`, {
        method: 'POST',
        headers: { Cookie: userCookie, ...(path !== '/api/upload' ? { 'Content-Type': 'application/json' } : {}) },
        body: body(),
      })
      expect(withLogin.ok, path).toBe(true)
    }
  })

  it('attributes token-created sites to the token owner, so they appear in their My Uploads', async () => {
    const ownerEmail = `token-owner-${randomUUID()}@example.com`
    const owner = await fetch(`${getBaseUrl()}/api/admin/users`, {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Token Owner', email: ownerEmail, password }),
    })
    expect(owner.status).toBe(200)
    const ownerId = (await owner.json()).id
    const ownerLogin = await fetch(`${getBaseUrl()}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ownerEmail, password }),
    })
    const ownerCookie = ownerLogin.headers.get('set-cookie')?.split(';')[0] ?? ''

    const owned = await fetch(`${getBaseUrl()}/api/admin/tokens`, {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: `owned-${randomUUID()}`, user_id: ownerId }),
    })
    const ownedToken = (await owned.json()).token

    // Unowned token leaves uploads unattributed.
    const unowned = await fetch(`${getBaseUrl()}/api/admin/tokens`, {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: `unowned-${randomUUID()}` }),
    })
    const unownedToken = (await unowned.json()).token

    const post = (token: string) => {
      const form = new FormData()
      form.append('file', new Blob(['<h1>token upload</h1>'], { type: 'text/html' }), 'index.html')
      return fetch(`${getBaseUrl()}/api/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form })
    }

    const ownedUpload = await post(ownedToken).then(readJson<Record<string, string>>)
    const unownedUpload = await post(unownedToken).then(readJson<Record<string, string>>)

    // The token owner sees only their own token-created site.
    const mine = await fetch(`${getBaseUrl()}/api/user/uploads?limit=100`, { headers: { Cookie: ownerCookie } })
      .then(readJson<{ items: Array<{ slug: string }> }>)
    const mineSlugs = mine.items.map((i) => i.slug)
    expect(mineSlugs).toContain(ownedUpload.slug)
    expect(mineSlugs).not.toContain(unownedUpload.slug)

    // The unrelated registered user does not see it either.
    const other = await fetch(`${getBaseUrl()}/api/user/uploads?limit=100`, { headers: { Cookie: userCookie } })
      .then(readJson<{ items: Array<{ slug: string }> }>)
    expect(other.items.map((i) => i.slug)).not.toContain(ownedUpload.slug)
  })

  it('lets a registered user manage their own API tokens', async () => {
    const nickname = `self-${randomUUID()}`
    const created = await fetch(`${getBaseUrl()}/api/user/tokens`, {
      method: 'POST',
      headers: { Cookie: userCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname }),
    })
    expect(created.status).toBe(200)
    const { token } = await created.json()

    const listed = await fetch(`${getBaseUrl()}/api/user/tokens`, { headers: { Cookie: userCookie } })
      .then(readJson<{ tokens: Array<{ nickname: string }> }>)
    expect(listed.tokens.map((t) => t.nickname)).toContain(nickname)

    // A self-service token attributes uploads to its owner.
    const form = new FormData()
    form.append('file', new Blob(['<h1>self token</h1>'], { type: 'text/html' }), 'index.html')
    const upload = await fetch(`${getBaseUrl()}/api/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    }).then(readJson<Record<string, string>>)
    const mine = await fetch(`${getBaseUrl()}/api/user/uploads?limit=100`, { headers: { Cookie: userCookie } })
      .then(readJson<{ items: Array<{ slug: string }> }>)
    expect(mine.items.map((i) => i.slug)).toContain(upload.slug)

    // Another user cannot revoke it, and the owner can.
    const otherEmail = `not-owner-${randomUUID()}@example.com`
    await fetch(`${getBaseUrl()}/api/admin/users`, {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Not Owner', email: otherEmail, password }),
    })
    const otherLogin = await fetch(`${getBaseUrl()}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: otherEmail, password }),
    })
    const otherCookie = otherLogin.headers.get('set-cookie')?.split(';')[0] ?? ''
    const forbidden = await fetch(`${getBaseUrl()}/api/user/tokens/delete`, {
      method: 'POST',
      headers: { Cookie: otherCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname }),
    })
    expect(forbidden.status).toBe(404)

    const revoked = await fetch(`${getBaseUrl()}/api/user/tokens/delete`, {
      method: 'POST',
      headers: { Cookie: userCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname }),
    })
    expect(revoked.status).toBe(200)
    const after = await fetch(`${getBaseUrl()}/api/user/tokens`, { headers: { Cookie: userCookie } })
      .then(readJson<{ tokens: Array<{ nickname: string }> }>)
    expect(after.tokens.map((t) => t.nickname)).not.toContain(nickname)
  })

  it('disables public registration without disabling login for existing users', async () => {
    const config = await fetch(`${getBaseUrl()}/api/config`).then(res => res.json())
    expect(config).toMatchObject({ registeredUsersOnly: true, authEnabled: true, registrationEnabled: false })
    const registration = await fetch(`${getBaseUrl()}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Visitor', email: `visitor-${randomUUID()}@example.com`, password }),
    })
    expect(registration.status).toBe(403)
    const registerPage = await fetch(`${getBaseUrl()}/register`, { redirect: 'manual' })
    expect(registerPage.status).toBe(302)
    expect(registerPage.headers.get('location')).toBe('/')
    const loginPage = await fetch(`${getBaseUrl()}/login`).then(res => res.text())
    expect(loginPage).toContain('Log in')
    expect(loginPage).not.toContain('href="/register"')
  })

  it('lets admin and registered-user sessions open their respective dashboard views', async () => {
    const anonymous = await fetch(`${getBaseUrl()}/dashboard`, { redirect: 'manual' })
    expect(anonymous.status).toBe(302)
    expect(anonymous.headers.get('location')).toBe('/login')

    const admin = await fetch(`${getBaseUrl()}/dashboard`, { headers: { Cookie: adminCookie } })
    expect(admin.status).toBe(200)
    const adminHtml = await admin.text()
    expect(adminHtml).toContain('All Uploads')
    expect(adminHtml).not.toContain('Account Settings')
    expect(adminHtml).toContain('href="/dashboard"')

    const adminUploads = await fetch(`${getBaseUrl()}/api/admin/uploads`, { headers: { Cookie: adminCookie } })
    expect(adminUploads.status).toBe(200)
    expect((await adminUploads.json()).items.length).toBeGreaterThan(0)
    const adminUserUploads = await fetch(`${getBaseUrl()}/api/user/uploads`, { headers: { Cookie: adminCookie } })
    expect(adminUserUploads.status).toBe(401)

    const registered = await fetch(`${getBaseUrl()}/dashboard`, { headers: { Cookie: userCookie } })
    expect(registered.status).toBe(200)
    const registeredHtml = await registered.text()
    expect(registeredHtml).toContain('My Uploads')
    expect(registeredHtml).toContain('Account Settings')
    const registeredUploads = await fetch(`${getBaseUrl()}/api/user/uploads`, { headers: { Cookie: userCookie } })
    expect(registeredUploads.status).toBe(200)
    const registeredAdminUploads = await fetch(`${getBaseUrl()}/api/admin/uploads`, { headers: { Cookie: userCookie } })
    expect(registeredAdminUploads.status).toBe(401)
  })

  it('rejects a signed session after the account is deleted', async () => {
    const deletion = await fetch(`${getBaseUrl()}/api/admin/users/${userId}/delete`, {
      method: 'POST',
      headers: { Cookie: adminCookie },
    })
    expect(deletion.status).toBe(200)
    const res = await fetch(`${getBaseUrl()}/api/paste`, {
      method: 'POST',
      headers: { Cookie: userCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: '<h1>test</h1>' }),
    })
    expect(res.status).toBe(401)
  })
})

describe('replace content API integration', () => {
  let adminCookie: string
  let userCookie: string
  let userId: string
  const email = `update-${randomUUID()}@example.com`
  const password = 'test-password-123'
  let ipCounter = 0

  // The suite performs more than the 25/hour per-IP upload budget; give each
  // request its own forwarded client IP so the rate limiter does not interfere.
  function nextHeaders(headers: Record<string, string> = {}): Record<string, string> {
    ipCounter += 1
    return { ...headers, 'cf-connecting-ip': `10.90.${Math.floor(ipCounter / 250)}.${ipCounter % 250}` }
  }

  function updateUrl(slug: string) {
    return `${getBaseUrl()}/api/uploads/${slug}/content`
  }

  async function createSite(
    filename: string,
    extra: Record<string, string> = {},
    headers: Record<string, string> = {}
  ): Promise<Record<string, string>> {
    const res = await fetch(`${getBaseUrl()}/api/upload`, {
      method: 'POST',
      body: uploadForm(filename, extra),
      headers: nextHeaders(headers),
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`create ${filename} failed: ${res.status} ${body}`)
    }
    return readJson(res)
  }

  async function update(
    slug: string,
    body: FormData,
    headers: Record<string, string> = {}
  ): Promise<Response> {
    return fetch(updateUrl(slug), { method: 'PUT', body, headers: nextHeaders(headers) })
  }

  beforeAll(async () => {
    const adminLogin = await fetch(`${getBaseUrl()}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-admin-password' }),
    })
    expect(adminLogin.status).toBe(200)
    adminCookie = adminLogin.headers.get('set-cookie')?.split(';')[0] ?? ''

    const createdUser = await fetch(`${getBaseUrl()}/api/admin/users`, {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Update User', email, password }),
    })
    expect(createdUser.status).toBe(200)
    userId = (await createdUser.json()).id
    const login = await fetch(`${getBaseUrl()}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    expect(login.status).toBe(200)
    userCookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
  })

  it('replaces HTML content at the original URL without adding a row or changing settings', async () => {
    const created = await createSite('dummy.html', { title: 'Keep me', password: 'secret' }, { Cookie: userCookie })
    const slug = created.slug!
    const unlockToken = new URL(created.url_with_unlock!).searchParams.get('unlock')!
    const unlockQuery = `?unlock=${encodeURIComponent(unlockToken)}`

    const before = await fetch(`${getBaseUrl()}/api/user/uploads?limit=100`, { headers: { Cookie: userCookie } }).then(readJson<{ total: number; items: Array<Record<string, unknown>> }>)
    const beforeRow = before.items.find((i) => i.slug === slug)!
    expect(beforeRow).toBeDefined()

    const replacement = `<!DOCTYPE html><html><head><title>Replaced</title></head><body><h1>Replaced Content</h1></body></html>`
    const form = new FormData()
    form.append('file', new Blob([replacement], { type: 'text/html' }), 'index.html')

    const res = await update(slug, form, { Cookie: userCookie })
    const data = await readJson<Record<string, string>>(res)
    expect(res.status).toBe(200)
    expect(data.slug).toBe(slug)
    expect(data.url).toBe(created.url)
    expect(data.entry_point).not.toBe(beforeRow.entry_point)
    expect(data).not.toHaveProperty('owner_token')

    // Original hosted URL still requires the password, and the unlock link
    // serves the replacement.
    const locked = await siteRequest(slug, '/')
    expect(locked.status).toBe(302)
    expect(locked.headers.get('location')).toBe('/_jolt/unlock')
    const unlocked = await siteRequest(slug, `/${unlockQuery}`)
    expect(unlocked.status).toBe(200)
    expect(await unlocked.text()).toContain('Replaced Content')

    // Settings and identity are preserved.
    const after = await fetch(`${getBaseUrl()}/api/user/uploads?limit=100`, { headers: { Cookie: userCookie } }).then(readJson<{ total: number; items: Array<Record<string, unknown>> }>)
    expect(after.total).toBe(before.total)
    const row = after.items.find((i) => i.slug === slug)!
    expect(row.entry_point).toBe(data.entry_point)
    expect(row.created_at).toBe(beforeRow.created_at)
    expect(row.expires_at).toBe(beforeRow.expires_at)
    expect(row.password_hash).toBe(beforeRow.password_hash)
    expect(row.user_id).toBe(beforeRow.user_id)

    // The original entry path now serves the replacement too.
    const oldAsset = await siteRequest(slug, `/index.html${unlockQuery}`)
    expect(oldAsset.status).toBe(200)
    expect(await oldAsset.text()).toContain('Replaced Content')
  })

  it('serves replacement ZIP assets and 404s for omitted old assets', async () => {
    const created = await createSite('dummy-site.zip', {}, { Cookie: userCookie })
    const slug = created.slug!

    // Old site has style.css.
    const oldCss = await siteRequest(slug, '/style.css')
    expect(oldCss.status).toBe(200)

    const res = await update(slug, replaceForm('replacement-site.zip'), { Cookie: userCookie })
    expect(res.status).toBe(200)

    const index = await siteRequest(slug, '/')
    expect(await index.text()).toContain('Replacement Content')
    const newCss = await siteRequest(slug, '/new-style.css')
    expect(newCss.status).toBe(200)
    expect(await newCss.text()).toContain('rebeccapurple')
    const omitted = await siteRequest(slug, '/style.css')
    expect(omitted.status).toBe(404)
  })

  it('changes entry point from Markdown to HTML and to a nested ZIP entry point', async () => {
    const created = await createSite('dummy.html', {}, { Cookie: userCookie })
    const slug = created.slug!

    // HTML -> Markdown
    const toMd = new FormData()
    toMd.append('file', new Blob([new TextEncoder().encode('# Updated Notes\n\nHello')], { type: 'text/markdown' }), 'notes.md')
    const mdRes = await update(slug, toMd, { Cookie: userCookie })
    const mdData = await readJson<Record<string, string>>(mdRes)
    expect(mdRes.status).toBe(200)
    expect(mdData.entry_point).toMatch(/index\.md$/)
    const mdView = await siteRequest(slug, '/')
    expect(await mdView.text()).toContain('Updated Notes')

    // Markdown -> nested ZIP entry point
    const zipRes = await update(slug, replaceForm('nested-entry-site.zip'), { Cookie: userCookie })
    const zipData = await readJson<Record<string, string>>(zipRes)
    expect(zipRes.status).toBe(200)
    expect(zipData.entry_point).toMatch(/pages\/home\.html$/)
    const zipView = await siteRequest(slug, '/')
    expect(await zipView.text()).toContain('Nested Entry')
  })

  it('requires both a login and the owner token in restricted mode, and rejects invalid tokens', async () => {
    // Simulate an older anonymous upload (no user_id) that predates restricted mode.
    const { randomUUID: uuid } = await import('crypto')
    const { insertUpload, findUploadBySlug } = await import('~/server/utils/db')
    const { mkdirSync, writeFileSync } = await import('fs')
    const anonSlug = `anon-${uuid().slice(0, 8)}`
    const anonToken = `tok-${uuid()}`
    const storage = join(process.cwd(), 'test', 'tmp-storage')
    mkdirSync(join(storage, anonSlug), { recursive: true })
    writeFileSync(join(storage, anonSlug, 'index.html'), '<h1>old anon site</h1>')
    insertUpload(uuid(), anonSlug, `${anonSlug}/index.html`, null, anonToken, null, null, null)
    expect(findUploadBySlug(anonSlug)?.user_id).toBeNull()

    // With no login and no API token there is no authenticated client.
    const tokenOnly = await update(anonSlug, replaceForm('replacement-site.zip', { owner_token: anonToken }))
    expect(tokenOnly.status).toBe(401)

    // With a login but no token, the unrelated user still cannot update it.
    const missing = await update(anonSlug, replaceForm('replacement-site.zip'), { Cookie: userCookie })
    expect(missing.status).toBe(403)

    const invalid = await update(anonSlug, replaceForm('replacement-site.zip', { owner_token: 'not-the-token' }), { Cookie: userCookie })
    expect(invalid.status).toBe(403)

    // The token must be sent in the form body, not the URL.
    const inUrl = await fetch(`${updateUrl(anonSlug)}?owner_token=${encodeURIComponent(anonToken)}`, {
      method: 'PUT',
      body: replaceForm('replacement-site.zip'),
      headers: nextHeaders({ Cookie: userCookie }),
    })
    expect(inUrl.status).toBe(403)

    // Login + owner token together authorize the update.
    const ok = await update(anonSlug, replaceForm('replacement-site.zip', { owner_token: anonToken }), { Cookie: userCookie })
    expect(ok.status).toBe(200)
  })

  it('rejects an API token without the owner token, but lets an admin and the owner update', async () => {
    const created = await createSite('dummy.html', {}, { Cookie: userCookie })
    const slug = created.slug!

    const tokenResponse = await fetch(`${getBaseUrl()}/api/admin/tokens`, {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: `update-${randomUUID()}`, user_id: userId }),
    })
    const { token } = await tokenResponse.json()

    // An API token authenticates the client but is not ownership proof: the
    // owner token is still required to replace someone's site.
    const apiWithoutOwner = await update(slug, replaceForm('replacement-site.zip'), { Authorization: `Bearer ${token}` })
    expect(apiWithoutOwner.status).toBe(403)

    const apiWithOwner = await update(slug, replaceForm('replacement-site.zip', { owner_token: created.owner_token! }), { Authorization: `Bearer ${token}` })
    expect(apiWithOwner.status).toBe(200)

    const notOwner = await update(slug, replaceForm('replacement-site.zip'), { Cookie: userCookie })
    // The registered user created this site, so they own it.
    expect(notOwner.status).toBe(200)

    const admin = await update(slug, replaceForm('dummy-site.zip'), { Cookie: adminCookie })
    expect(admin.status).toBe(200)
  })

  it('rejects a non-owner registered user', async () => {
    const created = await createSite('dummy.html', {}, { Cookie: userCookie })
    const slug = created.slug!

    // A different registered user cannot update another user's site.
    const otherEmail = `other-${randomUUID()}@example.com`
    const otherUser = await fetch(`${getBaseUrl()}/api/admin/users`, {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Other User', email: otherEmail, password }),
    })
    expect(otherUser.status).toBe(200)
    const otherLogin = await fetch(`${getBaseUrl()}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: otherEmail, password }),
    })
    const otherCookie = otherLogin.headers.get('set-cookie')?.split(';')[0] ?? ''

    const res = await update(slug, replaceForm('replacement-site.zip'), { Cookie: otherCookie })
    expect(res.status).toBe(403)
  })

  it('rejects updates to expired sites and leaves prior content intact on invalid uploads', async () => {
    const created = await createSite('dummy-site.zip', {}, { Cookie: userCookie })
    const slug = created.slug!

    // Invalid ZIP leaves the previous site usable.
    const bad = await update(slug, replaceForm('escape-site.zip'), { Cookie: userCookie })
    expect(bad.status).toBe(400)
    const stillThere = await siteRequest(slug, '/style.css')
    expect(stillThere.status).toBe(200)
    expect(await stillThere.text()).toContain('font-family')

    const noHtml = await update(slug, replaceForm('no-html.zip'), { Cookie: userCookie })
    expect(noHtml.status).toBe(400)

    // Expire the site, then reject the update.
    const expiration = await fetch(`${getBaseUrl()}/api/admin/upload/${slug}/expiration`, {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresAt: new Date(Date.now() - 60_000).toISOString() }),
    })
    expect(expiration.status).toBe(200)
    const expired = await update(slug, replaceForm('replacement-site.zip'), { Cookie: userCookie })
    expect(expired.status).toBe(404)
  })

  it('treats concurrent updates as a conflict', async () => {
    const created = await createSite('dummy.html', {}, { Cookie: userCookie })
    const slug = created.slug!

    const [a, b] = await Promise.all([
      update(slug, replaceForm('replacement-site.zip'), { Cookie: userCookie }),
      update(slug, replaceForm('dummy-site.zip'), { Cookie: userCookie }),
    ])
    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual([200, 409])
  })

  it('removes replacement content on deletion and expiration cleanup', async () => {
    const created = await createSite('dummy.html', { title: 'Delete me' }, { Cookie: userCookie })
    const slug = created.slug!
    const token = created.owner_token!

    const updateRes = await update(slug, replaceForm('replacement-site.zip'), { Cookie: userCookie })
    expect(updateRes.status).toBe(200)

    const del = await fetch(`${getBaseUrl()}/api/paste/${slug}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner_token: token }),
    })
    expect(del.status).toBe(200)

    const view = await fetch(`${getBaseUrl()}/view/${slug}`, { redirect: 'manual' })
    expect([404, 302]).toContain(view.status)
    const hosted = await siteRequest(slug, '/')
    expect(hosted.status).toBe(404)
  })
})

describe('hosted site data API integration', () => {
  let adminCookie: string
  let userCookie: string
  const email = `data-${randomUUID()}@example.com`
  const password = 'test-password-123'
  const sitePassword = 'site-secret-1'
  let ipCounter = 0

  function nextHeaders(headers: Record<string, string> = {}): Record<string, string> {
    ipCounter += 1
    return { ...headers, 'cf-connecting-ip': `10.91.${Math.floor(ipCounter / 250)}.${ipCounter % 250}` }
  }

  async function createSite(
    extra: Record<string, string> = {},
    headers: Record<string, string> = {}
  ): Promise<Record<string, string>> {
    const res = await fetch(`${getBaseUrl()}/api/upload`, {
      method: 'POST',
      body: uploadForm('dummy.html', extra),
      headers: nextHeaders(headers),
    })
    if (!res.ok) throw new Error(`create failed: ${res.status} ${await res.text()}`)
    return readJson(res)
  }

  function setData(slug: string, enabled: boolean, headers: Record<string, string> = {}, ownerToken?: string) {
    return fetch(`${getBaseUrl()}/api/uploads/${slug}/data`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...nextHeaders(headers) },
      body: jsonBody({ enabled, ...(ownerToken ? { owner_token: ownerToken } : {}) }),
    })
  }

  async function signInForData(slug: string, sitePasswordValue: string): Promise<SiteResponse> {
    return siteRequest(slug, '/_jolt/data/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `password=${encodeURIComponent(sitePasswordValue)}`,
    })
  }

  /** The normal site password form, which works whether or not data is enabled. */
  async function unlockSite(slug: string, sitePasswordValue: string): Promise<SiteResponse> {
    return siteRequest(slug, '/_jolt/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `password=${encodeURIComponent(sitePasswordValue)}`,
    })
  }

  /** Creates a protected, data-enabled site and signs in for a data session. */
  async function createDataSite() {
    const created = await createSite({ password: sitePassword }, { Cookie: userCookie })
    const enabled = await setData(created.slug!, true, { Cookie: userCookie })
    expect(enabled.status).toBe(200)
    const login = await signInForData(created.slug!, sitePassword)
    expect(login.status).toBe(303)
    const dataCookie = `jolt_data=${cookieValue(login, 'jolt_data')}`
    const viewCookie = `jolt_view=${cookieValue(login, 'jolt_view')}`
    return { created, dataCookie, viewCookie, cookie: cookieHeader(viewCookie, dataCookie) }
  }

  async function uploadIdFor(slug: string): Promise<string> {
    const { findUploadBySlug } = await import('~/server/utils/db')
    const row = findUploadBySlug(slug)
    if (!row) throw new Error(`no upload row for ${slug}`)
    return row.id
  }

  beforeAll(async () => {
    const adminLogin = await fetch(`${getBaseUrl()}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-admin-password' }),
    })
    expect(adminLogin.status).toBe(200)
    adminCookie = adminLogin.headers.get('set-cookie')?.split(';')[0] ?? ''
    const createdUser = await fetch(`${getBaseUrl()}/api/admin/users`, {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Data User', email, password }),
    })
    expect(createdUser.status).toBe(200)
    const login = await fetch(`${getBaseUrl()}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    expect(login.status).toBe(200)
    userCookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
  })

  it('requires a password before data can be enabled', async () => {
    const created = await createSite({}, { Cookie: userCookie })
    const res = await setData(created.slug!, true, { Cookie: userCookie })
    expect(res.status).toBe(409)
    const payload = await res.json()
    expect(payload.message).toMatch(/password/i)
  })

  it('honours enable_data=true at upload time without the dashboard', async () => {
    const created = await createSite({ password: sitePassword, enable_data: 'true' }, { Cookie: userCookie })
    expect(created.data_enabled).toBe('true')

    // The data API answers with the 401 sign-in shape (enabled), not the 404 of a
    // data-disabled site.
    const items = await siteRequest(created.slug!, '/_jolt/data/v1/collections/todos/items')
    expect(items.status).toBe(401)
    const payload = await items.json()
    expect(payload.login_url).toBe('/_jolt/data/login')
  })

  it('refuses enable_data=true when the upload has no password', async () => {
    const res = await fetch(`${getBaseUrl()}/api/upload`, {
      method: 'POST',
      body: uploadForm('dummy.html', { enable_data: 'true' }),
      headers: nextHeaders({ Cookie: userCookie }),
    })
    expect(res.status).toBe(400)
    const payload = await res.json()
    expect(payload.message).toMatch(/password/i)
  })

  it('ignores a non-truthy enable_data value', async () => {
    const created = await createSite({ password: sitePassword, enable_data: 'false' }, { Cookie: userCookie })
    expect(created.data_enabled).toBeUndefined()

    const items = await siteRequest(created.slug!, '/_jolt/data/v1/collections/todos/items')
    expect(items.status).toBe(404)
  })

  it('honours enable_data=true on a programmatic upload with an API token', async () => {
    const tokenRes = await fetch(`${getBaseUrl()}/api/user/tokens`, {
      method: 'POST',
      headers: { Cookie: userCookie, 'Content-Type': 'application/json' },
      body: jsonBody({ nickname: `data-${randomUUID()}` }),
    })
    expect(tokenRes.status).toBe(200)
    const { token } = await tokenRes.json()

    const created = await fetch(`${getBaseUrl()}/api/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, ...nextHeaders() },
      body: uploadForm('dummy.html', { password: sitePassword, enable_data: 'true' }),
    }).then(readJson<Record<string, string>>)
    expect(created.data_enabled).toBe('true')

    const items = await siteRequest(created.slug!, '/_jolt/data/v1/collections/todos/items')
    expect(items.status).toBe(401)
    const payload = await items.json()
    expect(payload.login_url).toBe('/_jolt/data/login')
  })

  it('keeps the data API enabled when site content is replaced', async () => {
    const created = await createSite({ password: sitePassword, enable_data: 'true' }, { Cookie: userCookie })

    const replacement = `<!DOCTYPE html><html><head><title>Replaced</title></head><body><h1>Replaced Content</h1></body></html>`
    const form = new FormData()
    form.append('file', new Blob([replacement], { type: 'text/html' }), 'index.html')
    form.append('owner_token', created.owner_token!)
    const replaced = await fetch(`${getBaseUrl()}/api/uploads/${created.slug}/content`, {
      method: 'PUT',
      headers: nextHeaders({ Cookie: userCookie }),
      body: form,
    })
    expect(replaced.status).toBe(200)

    // The replacement is live: the protected root still redirects to Jolt's unlock form.
    const page = await siteRequest(created.slug!, '/')
    expect(page.status).toBe(302)
    expect(page.headers.get('location')).toBe('/_jolt/unlock')

    // Replacing files never touches the data toggle: still enabled, still sign-in gated.
    const items = await siteRequest(created.slug!, '/_jolt/data/v1/collections/todos/items')
    expect(items.status).toBe(401)
    const payload = await items.json()
    expect(payload.login_url).toBe('/_jolt/data/login')
  })

  it('refuses to enable data for a site the caller does not own', async () => {
    const created = await createSite({ password: sitePassword }, { Cookie: userCookie })

    const otherEmail = `data-other-${randomUUID()}@example.com`
    await fetch(`${getBaseUrl()}/api/admin/users`, {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Other', email: otherEmail, password }),
    })
    const otherLogin = await fetch(`${getBaseUrl()}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: otherEmail, password }),
    })
    const otherCookie = otherLogin.headers.get('set-cookie')?.split(';')[0] ?? ''

    const forbidden = await setData(created.slug!, true, { Cookie: otherCookie })
    expect(forbidden.status).toBe(403)

    // A signed-in owner can always disable, and admins can toggle any site.
    const adminEnable = await setData(created.slug!, true, { Cookie: adminCookie })
    expect(adminEnable.status).toBe(200)
    const adminDisable = await setData(created.slug!, false, { Cookie: adminCookie })
    expect(adminDisable.status).toBe(200)
  })

  it('keeps the data API off until the owner enables it', async () => {
    const created = await createSite({ password: sitePassword }, { Cookie: userCookie })

    const unlock = await unlockSite(created.slug!, sitePassword)
    expect(unlock.status).toBe(303)
    const viewCookie = cookieValue(unlock, 'jolt_view')
    expect(viewCookie).toBeTruthy()

    const off = await siteRequest(created.slug!, '/_jolt/data/v1/collections/todos/items', {
      cookie: `jolt_view=${viewCookie}`,
    })
    expect(off.status).toBe(404)

    const enable = await setData(created.slug!, true, { Cookie: userCookie })
    expect((await enable.json()).data_enabled).toBe(true)

    // The management list reports the toggle state.
    const listed = await fetch(`${getBaseUrl()}/api/user/uploads?limit=100`, { headers: { Cookie: userCookie } })
      .then(readJson<{ items: Array<{ slug: string; data_enabled: boolean; url: string }> }>)
    const row = listed.items.find((i) => i.slug === created.slug)!
    expect(row.data_enabled).toBe(true)
    expect(row.url).toBe(created.url)

    const on = await siteRequest(created.slug!, '/_jolt/data/v1/collections/todos/items', {
      cookie: `jolt_view=${viewCookie}`,
    })
    expect(on.status).toBe(200)
    expect(await on.json()).toEqual({ items: [], next_offset: null })
  })

  it('lets a view-only unlock holder read but never write', async () => {
    const created = await createSite({ password: sitePassword }, { Cookie: userCookie })
    await setData(created.slug!, true, { Cookie: userCookie })

    // Reading via the unlock link grants the view cookie, not data-admin.
    const unlockToken = new URL(created.url_with_unlock!).searchParams.get('unlock')!
    const unlocked = await siteRequest(created.slug!, `/?unlock=${encodeURIComponent(unlockToken)}`)
    expect(unlocked.status).toBe(200)
    const viewCookie = cookieValue(unlocked, 'jolt_view')
    expect(viewCookie).toBeTruthy()
    expect(cookieValue(unlocked, 'jolt_data')).toBeNull()

    const read = await siteRequest(created.slug!, '/_jolt/data/v1/collections/todos/items', {
      cookie: `jolt_view=${viewCookie}`,
    })
    expect(read.status).toBe(200)

    const write = await siteRequest(created.slug!, '/_jolt/data/v1/collections/todos/items', {
      method: 'POST',
      cookie: `jolt_view=${viewCookie}`,
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ value: { title: 'nope' } }),
    })
    expect(write.status).toBe(403)

    const remove = await siteRequest(
      created.slug!,
      `/_jolt/data/v1/collections/todos/items/${randomUUID()}`,
      { method: 'DELETE', cookie: `jolt_view=${viewCookie}` }
    )
    expect(remove.status).toBe(403)
  })

  it('returns 401 with the login URL for anonymous data reads', async () => {
    const { created } = await createDataSite()
    const anonymous = await siteRequest(created.slug!, '/_jolt/data/v1/collections/todos/items')
    expect(anonymous.status).toBe(401)
    const payload = await anonymous.json<{ login_url: string }>()
    expect(payload.login_url).toBe('/_jolt/data/login')
    expect(anonymous.headers.get('cache-control')).toBe('no-store')
  })

  it('rejects a wrong password and issues a host-only HttpOnly data cookie on success', async () => {
    const created = await createSite({ password: sitePassword }, { Cookie: userCookie })
    await setData(created.slug!, true, { Cookie: userCookie })

    const wrong = await signInForData(created.slug!, 'not-the-password')
    expect(wrong.status).toBe(401)
    expect(cookieValue(wrong, 'jolt_data')).toBeNull()
    expect(await wrong.text()).toContain('Wrong password')

    const ok = await signInForData(created.slug!, sitePassword)
    expect(ok.status).toBe(303)
    expect(ok.headers.get('location')).toBe('/')

    const dataCookieRaw = ok.cookies.find((c) => c.startsWith('jolt_data='))
    expect(dataCookieRaw).toBeDefined()
    expect(dataCookieRaw).toContain('HttpOnly')
    expect(dataCookieRaw).toContain('Path=/_jolt/data')
    expect(dataCookieRaw).toContain('SameSite=Strict')
    expect(dataCookieRaw).not.toContain('Domain=')
    expect(cookieValue(ok, 'jolt_view')).toBeTruthy()

    // The data login form requires an exact Origin.
    const noOrigin = await siteRequest(created.slug!, '/_jolt/data/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://evil.test' },
      body: `password=${encodeURIComponent(sitePassword)}`,
    })
    expect(noOrigin.status).toBe(403)
    expect(cookieValue(noOrigin, 'jolt_data')).toBeNull()
  })

  it('grants both cookies from the normal password form only when data is enabled', async () => {
    const plain = await createSite({ password: sitePassword }, { Cookie: userCookie })
    const plainPost = await siteRequest(plain.slug!, '/_jolt/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `password=${encodeURIComponent(sitePassword)}`,
    })
    expect(plainPost.status).toBe(303)
    expect(cookieValue(plainPost, 'jolt_view')).toBeTruthy()
    expect(cookieValue(plainPost, 'jolt_data')).toBeNull()

    const dataSite = await createSite({ password: sitePassword }, { Cookie: userCookie })
    await setData(dataSite.slug!, true, { Cookie: userCookie })
    const dataPost = await siteRequest(dataSite.slug!, '/_jolt/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `password=${encodeURIComponent(sitePassword)}`,
    })
    expect(dataPost.status).toBe(303)
    expect(cookieValue(dataPost, 'jolt_view')).toBeTruthy()
    expect(cookieValue(dataPost, 'jolt_data')).toBeTruthy()

    // A mismatched Origin must not grant data-admin on a data-enabled site.
    const mismatched = await siteRequest(dataSite.slug!, '/_jolt/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://evil.test' },
      body: `password=${encodeURIComponent(sitePassword)}`,
    })
    expect(mismatched.status).toBe(403)
    expect(cookieValue(mismatched, 'jolt_data')).toBeNull()
  })

  it('supports the full record lifecycle for a data session', async () => {
    const { created, dataCookie } = await createDataSite()
    const slug = created.slug!
    const base = '/_jolt/data/v1/collections/todos/items'

    const created1 = await siteRequest(slug, base, {
      method: 'POST',
      cookie: dataCookie,
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ value: { title: 'write docs', done: false } }),
    })
    expect(created1.status).toBe(201)
    const first = await created1.json<{ id: string; value: { title: string }; created_at: string }>()
    expect(first.value).toEqual({ title: 'write docs', done: false })
    expect(first.created_at).toBeTruthy()

    const created2 = await siteRequest(slug, base, {
      method: 'POST',
      cookie: dataCookie,
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ value: { title: 'ship it', done: false } }),
    })
    expect(created2.status).toBe(201)

    const list = await siteRequest(slug, base, { cookie: dataCookie })
    expect(list.status).toBe(200)
    const page = await list.json<{ items: Array<{ id: string }>; next_offset: number | null }>()
    expect(page.items.map((i) => i.id)).toEqual([first.id, (await created2.json<{ id: string }>()).id])
    expect(page.next_offset).toBeNull()

    const patched = await siteRequest(slug, `${base}/${first.id}`, {
      method: 'PATCH',
      cookie: dataCookie,
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ value: { title: 'write docs', done: true } }),
    })
    expect(patched.status).toBe(200)
    expect((await patched.json<{ value: { done: boolean } }>()).value.done).toBe(true)

    const removed = await siteRequest(slug, `${base}/${first.id}`, {
      method: 'DELETE',
      cookie: dataCookie,
    })
    expect(removed.status).toBe(204)

    const missing = await siteRequest(slug, `${base}/${first.id}`, {
      method: 'DELETE',
      cookie: dataCookie,
    })
    expect(missing.status).toBe(404)

    const after = await siteRequest(slug, base, { cookie: dataCookie })
    const remaining = await after.json<{ items: Array<{ id: string }> }>()
    expect(remaining.items).toHaveLength(1)

    // Paging is bounded and validated.
    expect((await siteRequest(slug, `${base}?limit=0`, { cookie: dataCookie })).status).toBe(400)
    expect((await siteRequest(slug, `${base}?limit=101`, { cookie: dataCookie })).status).toBe(400)
    expect((await siteRequest(slug, `${base}?offset=-1`, { cookie: dataCookie })).status).toBe(400)
    expect((await siteRequest(slug, `${base}?limit=1`, { cookie: dataCookie })).status).toBe(200)
  })

  it('rejects bad collections, values, content types, and oversized bodies', async () => {
    const { created, dataCookie } = await createDataSite()
    const slug = created.slug!
    const post = (path: string, body: string, headers: Record<string, string> = {}) =>
      siteRequest(slug, path, {
        method: 'POST',
        cookie: dataCookie,
        headers: { 'content-type': 'application/json', ...headers },
        body,
      })

    expect((await post('/_jolt/data/v1/collections/Bad-Name/items', jsonBody({ value: {} }))).status).toBe(400)
    expect((await post('/_jolt/data/v1/collections/has%20space/items', jsonBody({ value: {} }))).status).toBe(400)
    expect((await post('/_jolt/data/v1/collections/1bad/items', jsonBody({ value: {} }))).status).toBe(400)
    expect((await post('/_jolt/data/v1/collections/todos/items', jsonBody({ value: [1, 2] }))).status).toBe(400)
    expect((await post('/_jolt/data/v1/collections/todos/items', jsonBody({ value: 'text' }))).status).toBe(400)
    expect((await post('/_jolt/data/v1/collections/todos/items', 'not json')).status).toBe(400)
    expect((await post('/_jolt/data/v1/collections/todos/items', jsonBody({}))).status).toBe(400)

    // A record over the record limit is rejected even though the request body is
    // within the body bound.
    const bigRecord = jsonBody({ value: { text: 'x'.repeat(MAX_RECORD_BYTES) } })
    expect(bigRecord.length).toBeLessThan(DATA_BODY_MAX_BYTES)
    expect((await post('/_jolt/data/v1/collections/todos/items', bigRecord)).status).toBe(413)

    // A body over the body bound is rejected before parsing.
    const huge = jsonBody({ value: { text: 'y'.repeat(DATA_BODY_MAX_BYTES) } })
    expect((await post('/_jolt/data/v1/collections/todos/items', huge)).status).toBe(413)

    // Non-JSON content types are refused.
    const wrongType = await siteRequest(slug, '/_jolt/data/v1/collections/todos/items', {
      method: 'POST',
      cookie: dataCookie,
      headers: { 'content-type': 'text/plain' },
      body: jsonBody({ value: {} }),
    })
    expect(wrongType.status).toBe(400)
  })

  it('enforces the per-site collection quota', async () => {
    const { created, dataCookie } = await createDataSite()
    const slug = created.slug!
    for (let i = 0; i < MAX_COLLECTIONS; i++) {
      const res = await siteRequest(slug, `/_jolt/data/v1/collections/list-${i}/items`, {
        method: 'POST',
        cookie: dataCookie,
        headers: { 'content-type': 'application/json' },
        body: jsonBody({ value: { i } }),
      })
      expect(res.status, `collection ${i}`).toBe(201)
    }
    const eleventh = await siteRequest(slug, '/_jolt/data/v1/collections/one-more/items', {
      method: 'POST',
      cookie: dataCookie,
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ value: { i: 10 } }),
    })
    expect(eleventh.status).toBe(409)
  })

  it('requires an exact Origin on mutations', async () => {
    const { created, dataCookie } = await createDataSite()
    const slug = created.slug!
    const path = '/_jolt/data/v1/collections/todos/items'

    const noOrigin = await siteRequest(slug, path, {
      method: 'POST',
      cookie: dataCookie,
      headers: { 'content-type': 'application/json', origin: '' },
      body: jsonBody({ value: {} }),
    })
    expect(noOrigin.status).toBe(403)

    const wrongOrigin = await siteRequest(slug, path, {
      method: 'POST',
      cookie: dataCookie,
      headers: { 'content-type': 'application/json', origin: 'http://elsewhere.test' },
      body: jsonBody({ value: {} }),
    })
    expect(wrongOrigin.status).toBe(403)

    const otherSiteOrigin = await siteRequest(slug, path, {
      method: 'POST',
      cookie: dataCookie,
      headers: { 'content-type': 'application/json', origin: siteOrigin('someone-else') },
      body: jsonBody({ value: {} }),
    })
    expect(otherSiteOrigin.status).toBe(403)

    // Browsers that send `Origin: null` (or omit it) on same-origin form POSTs
    // are accepted only when Fetch metadata confirms a same-origin request.
    for (const origin of ['', 'null']) {
      const browserStyle = await siteRequest(slug, path, {
        method: 'POST',
        cookie: dataCookie,
        headers: {
          'content-type': 'application/json',
          origin,
          'sec-fetch-site': 'same-origin',
        },
        body: jsonBody({ value: { title: 'same-origin browser post' } }),
      })
      expect(browserStyle.status, `origin=${origin}`).toBe(201)
    }

    const noMetadata = await siteRequest(slug, path, {
      method: 'POST',
      cookie: dataCookie,
      headers: { 'content-type': 'application/json', origin: '' },
      body: jsonBody({ value: {} }),
    })
    expect(noMetadata.status).toBe(403)

    const crossSiteMeta = await siteRequest(slug, path, {
      method: 'POST',
      cookie: dataCookie,
      headers: {
        'content-type': 'application/json',
        origin: 'null',
        'sec-fetch-site': 'cross-site',
      },
      body: jsonBody({ value: {} }),
    })
    expect(crossSiteMeta.status).toBe(403)
  })

  it('scopes cookies and records to a single site', async () => {
    const a = await createDataSite()
    const b = await createDataSite()

    const createdInA = await siteRequest(a.created.slug!, '/_jolt/data/v1/collections/todos/items', {
      method: 'POST',
      cookie: a.dataCookie,
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ value: { owner: 'A' } }),
    })
    expect(createdInA.status).toBe(201)

    // B never sees A's rows.
    const listB = await siteRequest(b.created.slug!, '/_jolt/data/v1/collections/todos/items', {
      cookie: b.dataCookie,
    })
    expect((await listB.json<{ items: unknown[] }>()).items).toHaveLength(0)

    // A's data cookie does not authenticate against B.
    const crossWrite = await siteRequest(b.created.slug!, '/_jolt/data/v1/collections/todos/items', {
      method: 'POST',
      cookie: a.dataCookie,
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ value: { owner: 'A' } }),
    })
    expect([401, 403]).toContain(crossWrite.status)

    const crossRead = await siteRequest(b.created.slug!, '/_jolt/data/v1/collections/todos/items', {
      cookie: a.dataCookie,
    })
    expect(crossRead.status).toBe(401)

    // And vice versa.
    const crossWriteBack = await siteRequest(a.created.slug!, '/_jolt/data/v1/collections/todos/items', {
      method: 'POST',
      cookie: b.dataCookie,
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ value: { owner: 'B' } }),
    })
    expect([401, 403]).toContain(crossWriteBack.status)
  })

  it('blocks application routes and database files on a site origin', async () => {
    const { created, dataCookie } = await createDataSite()
    const slug = created.slug!
    const uploadId = await uploadIdFor(slug)

    for (const path of ['/api/admin/session', '/api/config', '/admin', '/dashboard', '/view/anything', '/__nuxt_error']) {
      const res = await siteRequest(slug, path)
      expect(res.status, `${path} -> ${res.headers.get('location') ?? '(no location)'}`).toBe(404)
    }

    // Uploaded HTML cannot call the app's own APIs with the site's cookies.
    const apiCall = await siteRequest(slug, '/api/admin/uploads', { cookie: dataCookie })
    expect(apiCall.status).toBe(404)

    // The site's database and its sidecars are never downloadable.
    const seed = await siteRequest(slug, '/_jolt/data/v1/collections/todos/items', {
      method: 'POST',
      cookie: dataCookie,
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ value: { title: 'seed' } }),
    })
    expect(seed.status).toBe(201)
    expect(existsSync(dbFileFor(uploadId))).toBe(true)
    for (const suffix of ['.sqlite', '.sqlite-wal', '.sqlite-shm']) {
      const onSite = await siteRequest(slug, `/data/sites/${uploadId}${suffix}`)
      expect(onSite.status, `site ${suffix}`).toBe(404)
      const onApp = await fetch(`${getBaseUrl()}/data/sites/${uploadId}${suffix}`)
      expect(onApp.status, `app ${suffix}`).toBe(404)
    }

    // No permissive CORS is offered between the two origins.
    const cors = await siteRequest(slug, '/_jolt/data/v1/collections/todos/items', {
      cookie: dataCookie,
      headers: { origin: siteOrigin('other') },
    })
    expect(cors.headers.get('access-control-allow-origin')).toBeNull()
    expect(cors.headers.get('access-control-allow-credentials')).toBeNull()
  })

  it('confines each site to its own files', async () => {
    const a = await createSite({}, { Cookie: userCookie })
    const b = await createSite({}, { Cookie: userCookie })

    // Sites created from the same fixture both serve index.html, but neither can
    // reach the other's content through traversal.
    const own = await siteRequest(a.slug!, '/index.html')
    expect(own.status).toBe(200)

    for (const path of [
      `/..%2f${b.slug}%2findex.html`,
      `/..%2F..%2F..%2F${b.slug}%2Findex.html`,
      '/%2e%2e/%2e%2e/etc/passwd',
      '/../package.json',
      '/..%2f..%2f..%2fetc%2fpasswd',
    ]) {
      const res = await siteRequest(a.slug!, path)
      expect(res.status, path).toBe(404)
    }

    // A path that only exists in the other site is not served here.
    expect((await siteRequest(b.slug!, '/index.html')).status).toBe(200)
    expect((await siteRequest(a.slug!, '/secret.txt')).status).toBe(404)
  })

  it('throttles repeated wrong passwords', async () => {
    const created = await createSite({ password: sitePassword }, { Cookie: userCookie })
    await setData(created.slug!, true, { Cookie: userCookie })

    // Five failures are recorded, then the form rate limit takes over.
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await signInForData(created.slug!, 'wrong-password')
      expect(res.status, `attempt ${attempt}`).toBe(401)
    }
    const blocked = await signInForData(created.slug!, 'wrong-password')
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toBeTruthy()

    // Even the correct password is refused while the limiter is active.
    const correct = await signInForData(created.slug!, sitePassword)
    expect(correct.status).toBe(429)
  })

  it('revokes data sessions when the password rotates', async () => {
    const { created, dataCookie } = await createDataSite()
    const slug = created.slug!
    const itemsPath = '/_jolt/data/v1/collections/todos/items'

    const before = await siteRequest(slug, itemsPath, {
      method: 'POST',
      cookie: dataCookie,
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ value: { title: 'persisted' } }),
    })
    expect(before.status).toBe(201)

    const rotate = await fetch(`${getBaseUrl()}/api/user/uploads/${slug}/password`, {
      method: 'POST',
      headers: { Cookie: userCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'rotated-secret-2' }),
    })
    expect(rotate.status).toBe(200)

    const stale = await siteRequest(slug, itemsPath, {
      method: 'POST',
      cookie: dataCookie,
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ value: { title: 'rejected' } }),
    })
    expect([401, 403]).toContain(stale.status)

    // The records survive the rotation and the new password can write again.
    const login = await signInForData(slug, 'rotated-secret-2')
    expect(login.status).toBe(303)
    const fresh = `jolt_data=${cookieValue(login, 'jolt_data')}`
    const list = await siteRequest(slug, itemsPath, { cookie: fresh })
    expect((await list.json<{ items: unknown[] }>()).items).toHaveLength(1)
    const write = await siteRequest(slug, itemsPath, {
      method: 'POST',
      cookie: fresh,
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ value: { title: 'after rotation' } }),
    })
    expect(write.status).toBe(201)
  })

  it('preserves records across content replacement, disable, and re-enable', async () => {
    const { created, dataCookie } = await createDataSite()
    const slug = created.slug!
    const itemsPath = '/_jolt/data/v1/collections/todos/items'

    const write = await siteRequest(slug, itemsPath, {
      method: 'POST',
      cookie: dataCookie,
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ value: { title: 'keep me' } }),
    })
    expect(write.status).toBe(201)

    const replace = await fetch(`${getBaseUrl()}/api/uploads/${slug}/content`, {
      method: 'PUT',
      body: replaceForm('replacement-site.zip'),
      headers: nextHeaders({ Cookie: userCookie }),
    })
    expect(replace.status).toBe(200)

    const afterReplace = await siteRequest(slug, itemsPath, { cookie: dataCookie })
    expect((await afterReplace.json<{ items: unknown[] }>()).items).toHaveLength(1)

    // Disabling blocks reads and writes but keeps the rows.
    const disable = await setData(slug, false, { Cookie: userCookie })
    expect((await disable.json()).data_enabled).toBe(false)
    expect((await siteRequest(slug, itemsPath, { cookie: dataCookie })).status).toBe(404)
    const blockedWrite = await siteRequest(slug, itemsPath, {
      method: 'POST',
      cookie: dataCookie,
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ value: {} }),
    })
    expect(blockedWrite.status).toBe(404)

    // Re-enabling reveals the original records to the password holders again.
    const reEnable = await setData(slug, true, { Cookie: userCookie })
    expect((await reEnable.json()).data_enabled).toBe(true)
    const login = await signInForData(slug, sitePassword)
    expect(login.status).toBe(303)
    const fresh = `jolt_data=${cookieValue(login, 'jolt_data')}`
    const listed = await siteRequest(slug, itemsPath, { cookie: fresh })
    expect((await listed.json<{ items: Array<{ value: { title: string } }> }>()).items[0].value.title).toBe('keep me')
  })

  it('disables data when the password is cleared, keeping records until deletion', async () => {
    const { created, dataCookie } = await createDataSite()
    const slug = created.slug!
    const itemsPath = '/_jolt/data/v1/collections/todos/items'
    const uploadId = await uploadIdFor(slug)

    const write = await siteRequest(slug, itemsPath, {
      method: 'POST',
      cookie: dataCookie,
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ value: { title: 'survivor' } }),
    })
    expect(write.status).toBe(201)

    const clear = await fetch(`${getBaseUrl()}/api/user/uploads/${slug}/password`, {
      method: 'POST',
      headers: { Cookie: userCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: null }),
    })
    expect(clear.status).toBe(200)

    const listed = await fetch(`${getBaseUrl()}/api/user/uploads?limit=100`, { headers: { Cookie: userCookie } })
      .then(readJson<{ items: Array<{ slug: string; data_enabled: boolean }> }>)
    expect(listed.items.find((i) => i.slug === slug)!.data_enabled).toBe(false)

    // The site is now unprotected; its data API stays unavailable.
    expect((await siteRequest(slug, '/')).status).toBe(200)
    expect((await siteRequest(slug, itemsPath)).status).toBe(404)

    // Records are still on disk until the site is deleted.
    expect(existsSync(dbFileFor(uploadId))).toBe(true)

    const del = await fetch(`${getBaseUrl()}/api/paste/${slug}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner_token: created.owner_token }),
    })
    expect(del.status).toBe(200)
    expect(existsSync(dbFileFor(uploadId))).toBe(false)
  })

  it('removes the database file on administrator deletion', async () => {
    const { created, dataCookie } = await createDataSite()
    const slug = created.slug!
    const uploadId = await uploadIdFor(slug)

    const write = await siteRequest(slug, '/_jolt/data/v1/collections/todos/items', {
      method: 'POST',
      cookie: dataCookie,
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ value: { title: 'admin delete' } }),
    })
    expect(write.status).toBe(201)
    expect(existsSync(dbFileFor(uploadId))).toBe(true)

    const del = await fetch(`${getBaseUrl()}/api/admin/paste/${slug}/delete`, {
      method: 'POST',
      headers: { Cookie: adminCookie },
    })
    expect(del.status).toBe(200)
    expect(existsSync(dbFileFor(uploadId))).toBe(false)
    expect((await siteRequest(slug, '/')).status).toBe(404)
  })

  it('removes the database file during expiration cleanup and rejects later access', async () => {
    const { created, dataCookie } = await createDataSite()
    const slug = created.slug!
    const uploadId = await uploadIdFor(slug)

    const write = await siteRequest(slug, '/_jolt/data/v1/collections/todos/items', {
      method: 'POST',
      cookie: dataCookie,
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ value: { title: 'expire me' } }),
    })
    expect(write.status).toBe(201)

    const expiration = await fetch(`${getBaseUrl()}/api/admin/upload/${slug}/expiration`, {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresAt: new Date(Date.now() - 60_000).toISOString() }),
    })
    expect(expiration.status).toBe(200)

    // Expired sites reject reads and writes immediately.
    expect((await siteRequest(slug, '/')).status).toBe(404)
    const expiredWrite = await siteRequest(slug, '/_jolt/data/v1/collections/todos/items', {
      method: 'POST',
      cookie: dataCookie,
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ value: {} }),
    })
    expect(expiredWrite.status).toBe(404)

    // The scheduled cleanup removes the row, files, and database.
    vi.stubGlobal('defineTask', (definition: unknown) => definition)
    const task = await import('~/server/tasks/cleanup-expired')
    const run = (task.default as { run: () => { deleted: number } }).run
    run()

    expect(existsSync(dbFileFor(uploadId))).toBe(false)
    const { findUploadBySlug } = await import('~/server/utils/db')
    expect(findUploadBySlug(slug)).toBeUndefined()
  })

  it('refuses a stale view cookie and cannot re-enable data after the password is cleared', async () => {
    const created = await createSite({ password: sitePassword }, { Cookie: userCookie })
    const slug = created.slug!
    const items = '/_jolt/data/v1/collections/todos/items'
    await setData(slug, true, { Cookie: userCookie })

    const unlock = await unlockSite(slug, sitePassword)
    const viewCookie = `jolt_view=${cookieValue(unlock, 'jolt_view')}`
    expect((await siteRequest(slug, items, { cookie: viewCookie })).status).toBe(200)

    const clear = await fetch(`${getBaseUrl()}/api/user/uploads/${slug}/password`, {
      method: 'POST',
      headers: { Cookie: userCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: null }),
    })
    expect(clear.status).toBe(200)

    // Clearing the password disables data, so the still-valid view cookie reads nothing.
    expect((await siteRequest(slug, items, { cookie: viewCookie })).status).toBe(404)

    // And data cannot be re-enabled while the site is unprotected.
    const reEnable = await setData(slug, true, { Cookie: userCookie })
    expect(reEnable.status).toBe(409)
    const listed = await fetch(`${getBaseUrl()}/api/user/uploads?limit=100`, { headers: { Cookie: userCookie } })
      .then(readJson<{ items: Array<{ slug: string; data_enabled: boolean }> }>)
    expect(listed.items.find((i) => i.slug === slug)!.data_enabled).toBe(false)
  })

  it('rejects malformed and bare hosts under the site base', async () => {
    const port = serverPort()
    for (const host of [
      `a.b.${SITE_BASE_HOSTNAME}:${port}`,
      `${SITE_BASE_HOSTNAME}:${port}`,
      `-bad.${SITE_BASE_HOSTNAME}:${port}`,
    ]) {
      const res = await rawRequest({ path: '/api/admin/session', hostHeader: host })
      expect(res.status, host).toBe(404)
      expect(res.headers['set-cookie'], host).toBeUndefined()
    }
  })

  it('does not resurrect a deleted site from an in-flight write', async () => {
    const { created, dataCookie } = await createDataSite()
    const slug = created.slug!
    const uploadId = await uploadIdFor(slug)
    const items = '/_jolt/data/v1/collections/todos/items'

    const seed = await siteRequest(slug, items, {
      method: 'POST',
      cookie: dataCookie,
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ value: { title: 'seed' } }),
    })
    expect(seed.status).toBe(201)
    expect(existsSync(dbFileFor(uploadId))).toBe(true)

    // Manual resolver rather than Promise.withResolvers (Node 20 support).
    let settleStatus: (value: { status: number }) => void = () => {}
    const settled = new Promise<{ status: number }>((resolve) => {
      settleStatus = resolve
    })
    const host = `${slug}.${SITE_BASE_HOSTNAME}:${serverPort()}`
    const request = http.request(
      {
        host: '127.0.0.1',
        port: Number(serverPort()),
        method: 'POST',
        path: items,
        setHost: false,
        headers: { host, origin: `http://${host}`, cookie: dataCookie, 'content-type': 'application/json' },
      },
      (response) => {
        response.resume()
        response.on('end', () => settleStatus({ status: response.statusCode ?? 0 }))
      }
    )
    request.on('error', () => settleStatus({ status: 0 }))

    // Send only part of the body so the handler is parked reading the request.
    // Real (not fake) time is required here: the delay is what lets a second
    // process' HTTP handler reach its body read before we delete the site.
    request.write('{"value":{"title":"slow"')
    await new Promise((resolve) => setTimeout(resolve, 150))

    const del = await fetch(`${getBaseUrl()}/api/paste/${slug}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner_token: created.owner_token }),
    })
    expect(del.status).toBe(200)
    expect(existsSync(dbFileFor(uploadId))).toBe(false)

    request.end('}}')
    const result = await settled
    expect(result.status).toBe(404)
    // The re-check before the mutation stopped the write from recreating the file.
    expect(existsSync(dbFileFor(uploadId))).toBe(false)
  })

  it('builds management URLs from the runtime hosted origin, not the build-time value', async () => {
    const created = await createSite({}, { Cookie: userCookie })

    // The bundle was built with deliberately unusable origins and this server
    // runs with the real ones, with no NUXT_PUBLIC_* override to paper over it.
    // (Nuxt still serializes the baked config into the payload, so these
    // assertions are scoped to the rendered links.)
    const deletePage = await fetch(`${getBaseUrl()}/delete/${created.slug}?token=placeholder-token`)
    expect(deletePage.status).toBe(200)
    const deleteHtml = await deletePage.text()
    expect(deleteHtml).toContain(`href="${created.url}"`)
    expect(deleteHtml).not.toContain('href="http://stale-build-sites.invalid')

    const resultPage = await fetch(`${getBaseUrl()}/result/${created.slug}`)
    expect(resultPage.status).toBe(200)
    const resultHtml = await resultPage.text()
    expect(resultHtml).toContain(`href="${created.url}"`)
    expect(resultHtml).not.toContain('href="http://stale-build-sites.invalid')
  })
})

describe('AI Builder integration inventory A1–A23', () => {
  type Account = { id: string; cookie: string; email: string }
  type State = { revision: number; entry_file: string; files: Array<{ path: string; bytes: number; editable: boolean }>; editable_bytes: number; editable_files: number; opaque_files: number; target: { slug: string } | null; restore_available: boolean }
  type Operation = { op: string; path: string; content?: unknown }
  type CapturedRequest = { marker: string; body: { messages: Array<{ role: string; content: string }> } }
  type MockState = { requests: CapturedRequest[]; held: string[] }
  const storage = join(process.cwd(), 'test', 'tmp-storage')
  let env: Record<string, string>
  let admin: string
  let sql: Database.Database
  let ip = 0
  const password = 'ai-integration-password'
  const html = '<!doctype html><html><body>Original AI page</body></html>'
  const binary = Buffer.from([137, 80, 78, 71, 0, 255, 17, 34])
  const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex')
  const manifest = (files: Operation[]) => ({ summary: 'Integration change.', files })
  const add = (path: string, content: unknown): Operation => ({ op: 'add', path, content })
  const update = (path: string, content: unknown): Operation => ({ op: 'update', path, content })
  const remove = (path: string): Operation => ({ op: 'delete', path })
  const headers = (account?: Account, base = getBaseUrl(), extra: Record<string, string> = {}) => ({
    Origin: base, ...(account ? { Cookie: account.cookie } : {}),
    'cf-connecting-ip': `10.94.${Math.floor(++ip / 250)}.${ip % 250}`, ...extra,
  })
  function row(account: Account): AiWorkspaceRow | undefined {
    return sql.prepare<[string], AiWorkspaceRow>('SELECT * FROM ai_workspaces WHERE user_id = ?').get(account.id)
  }
  function uploadRow(slug: string): UploadRow {
    const result = sql.prepare<[string], UploadRow>('SELECT * FROM uploads WHERE slug = ?').get(slug)
    expect(result).toBeDefined()
    return result!
  }
  function root(account: Account) { return join(storage, '.workspaces', account.id) }
  function committed(account: Account): Record<string, string> {
    const current = row(account)
    if (!current?.current_generation) return {}
    const content = join(root(account), '.generations', current.current_generation, 'content')
    const result: Record<string, string> = {}
    function walk(dir: string, prefix = '') {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = `${prefix}${entry.name}`
        if (entry.isDirectory()) walk(join(dir, entry.name), `${path}/`)
        else result[path] = hash(readFileSync(join(dir, entry.name)))
      }
    }
    walk(content)
    return result
  }
  async function account(base = getBaseUrl(), aiBuildEnabled = true): Promise<Account> {
    const email = `ai-${randomUUID()}@example.com`
    const created = await fetch(`${base}/api/admin/users`, {
      method: 'POST', headers: { Cookie: admin, 'Content-Type': 'application/json' },
      body: jsonBody({ name: 'AI integration', email, password, ...(aiBuildEnabled ? { ai_build_enabled: true } : {}) }),
    })
    expect(created.status).toBe(200)
    const { id } = await created.json()
    const login = await fetch(`${getBaseUrl()}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: jsonBody({ email, password }),
    })
    expect(login.status).toBe(200)
    return { id, email, cookie: login.headers.get('set-cookie')!.split(';')[0]! }
  }
  async function api(account: Account | undefined, route: string, body?: unknown, base = getBaseUrl(), extra: Record<string, string> = {}) {
    return fetch(`${base}/api/ai/${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: headers(account, base, { 'Content-Type': 'application/json', ...extra }),
      ...(body === undefined ? {} : { body: jsonBody(body) }),
    })
  }
  async function state(account: Account): Promise<State> {
    const response = await api(account, 'files')
    expect(response.status).toBe(200)
    const { messages: _messages, ...workspace } = await response.json()
    return workspace
  }
  async function control(route: string, body?: unknown): Promise<MockState> {
    const response = await fetch(`${env.JOLT_AI_CONTROL_URL}/${route}`, {
      ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: jsonBody(body) }),
    })
    expect(response.status).toBe(200)
    return response.json()
  }
  async function queued(response: Record<string, unknown>): Promise<string> {
    const marker = `turn-${randomUUID()}`
    await control('queue', { marker, response })
    return marker
  }
  async function chat(account: Account, files: Operation[], options: Record<string, unknown> = {}) {
    const marker = await queued({ content: manifest(files), ...options })
    const response = await api(account, 'chat', { message: marker, revision: (await state(account)).revision })
    return { response, marker }
  }
  async function seed(account: Account) {
    const result = await chat(account, [add('index.html', html), add('style.css', 'body { color: red; }'), add('old.js', 'console.log("old")')])
    expect(result.response.status).toBe(200)
    return result
  }
  async function zip(files: Record<string, string | Buffer>) {
    const archive = archiver('zip', { zlib: { level: 9 } })
    const chunks: Buffer[] = []
    const finished = new Promise<Buffer>((resolve, reject) => {
      archive.on('data', chunk => chunks.push(chunk))
      archive.on('error', reject)
      archive.on('end', () => resolve(Buffer.concat(chunks)))
    })
    for (const [name, content] of Object.entries(files)) archive.append(content, { name })
    await archive.finalize()
    return finished
  }
  async function create(account: Account | undefined, files: Record<string, string | Buffer> = { 'index.html': html, 'old.js': 'original script', 'image.png': binary }, extra: Record<string, string> = {}, base = getBaseUrl()) {
    const form = new FormData()
    form.append('file', toBlob(await zip(files)), 'site.zip')
    for (const [name, value] of Object.entries(extra)) form.append(name, value)
    const requestHeaders = headers(account, base)
    if (!account) {
      const landing = await fetch(base)
      requestHeaders.Cookie = landing.headers.get('set-cookie')!.split(';')[0]!
    }
    const response = await fetch(`${base}/api/upload`, { method: 'POST', headers: requestHeaders, body: form })
    expect(response.status, await response.clone().text()).toBe(200)
    return response.json() as Promise<Record<string, string>>
  }
  async function attach(account: Account, slug: string) {
    return api(account, 'attach', { slug, revision: (await state(account)).revision })
  }
  async function publish(account: Account, slug: string, base = getBaseUrl()) {
    const form = new FormData()
    form.append('ai_workspace_revision', String((await state(account)).revision))
    return fetch(`${base}/api/uploads/${slug}/content`, { method: 'PUT', headers: headers(account, base), body: form })
  }
  async function preview(account: Account, options: Record<string, unknown> = {}, base = getBaseUrl(), extra: Record<string, string> = {}) {
    return api(account, 'preview', { revision: (await state(account)).revision, ...options }, base, extra)
  }
  async function unchanged(account: Account, action: () => Promise<Response>, status = 502) {
    const before = await state(account)
    const bytes = committed(account)
    const beforeRow = row(account)
    const response = await action()
    expect(response.status, await response.clone().text()).toBe(status)
    expect(await state(account)).toEqual(before)
    expect(committed(account)).toEqual(bytes)
    expect(row(account)).toEqual(beforeRow)
    return response
  }
  beforeAll(async () => {
    env = JSON.parse(readFileSync(join(process.cwd(), 'test', '.integration-env.json'), 'utf8'))
    const login = await fetch(`${getBaseUrl()}/api/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: jsonBody({ password: 'test-admin-password' }),
    })
    expect(login.status).toBe(200)
    admin = login.headers.get('set-cookie')!.split(';')[0]!
    // Initialize the shared schema even when running only the AI inventory.
    await account()
    sql = new Database(join(DATA_DIR, 'jolt.db'))
  })
  afterAll(async () => {
    try {
      const captured = (await control('state')).requests
      expect(captured.every(request => Boolean(request.marker))).toBe(true)
      expect(new Set(captured.map(request => request.marker)).size).toBe(captured.length)
      expect(JSON.stringify(captured)).not.toContain(env.JOLT_AI_API_KEY)
    } finally {
      sql?.close()
    }
  })

  it('admin settings stay masked and Build Mode gates every route, including registered admins', async () => {
    const user = await account(getBaseUrl(), false)
    const me = await fetch(`${getBaseUrl()}/api/auth/me`, { headers: { Cookie: user.cookie } }).then(res => res.json())
    expect(me.ai_build_enabled).toBe(0)
    const original = await fetch(`${getBaseUrl()}/api/admin/ai/settings`, { headers: { Cookie: admin } }).then(res => res.json())
    expect(original).toMatchObject({ available: true, source: 'env', has_key: true })
    const key = 'admin-integration-secret-2345'
    try {
      const saved = await fetch(`${getBaseUrl()}/api/admin/ai/settings`, {
        method: 'PUT', headers: { Cookie: admin, 'Content-Type': 'application/json' },
        body: jsonBody({ api_key: key, model: 'admin-integration-model' }),
      })
      expect(saved.status).toBe(200)
      const masked = await saved.text()
      expect(masked).not.toContain(key)
      expect(JSON.parse(masked)).toMatchObject({ source: 'admin', model: 'admin-integration-model', key_hint: '2345' })
      const settingsRow = sql.prepare('SELECT * FROM ai_settings WHERE id = 1').get()
      expect(JSON.stringify(settingsRow)).not.toContain(key)
      for (const [route, body] of [['files', undefined], ['files/index.html', undefined], ['chat', {}], ['attach', {}], ['restore', {}], ['reset', {}], ['preview', {}]] as const) {
        const rejected = await api(user, route, body, getBaseUrl(), { Cookie: `${user.cookie}; ${admin}` })
        expect(rejected.status).toBe(403)
        expect((await rejected.json()).error.code).toBe('builder_disabled')
      }
      const patch = await fetch(`${getBaseUrl()}/api/admin/users/${user.id}`, {
        method: 'PATCH', headers: { Cookie: admin, 'Content-Type': 'application/json' }, body: jsonBody({ ai_build_enabled: true }),
      })
      expect(patch.status).toBe(200)
      expect(await patch.json()).toMatchObject({ ai_build_enabled: 1 })
      expect((await chat(user, [add('index.html', html)])).response.status).toBe(200)
      await fetch(`${getBaseUrl()}/api/admin/users/${user.id}`, {
        method: 'PATCH', headers: { Cookie: admin, 'Content-Type': 'application/json' }, body: jsonBody({ ai_build_enabled: 0 }),
      }).then(res => expect(res.status).toBe(200))
      const rejected = await api(user, 'chat', { message: 'disabled again', revision: 1 })
      expect(rejected.status).toBe(403)
      expect((await rejected.json()).error.code).toBe('builder_disabled')
    } finally {
      const cleared = await fetch(`${getBaseUrl()}/api/admin/ai/settings`, {
        method: 'PUT', headers: { Cookie: admin, 'Content-Type': 'application/json' },
        body: jsonBody({ api_key: '', base_url: '', model: '' }),
      })
      expect(cleared.status).toBe(200)
      expect(await cleared.json()).toEqual(original)
    }
  })

  it('A1: missing key and kill switch fail closed without affecting ordinary uploads', async () => {
    const user = await account()
    const count = (await control('state')).requests.length
    for (const base of [env.JOLT_TEST_MISSING_KEY_URL!, env.JOLT_TEST_DISABLED_URL!]) {
      expect(await fetch(`${base}/api/config`).then(res => res.json())).toMatchObject({ aiBuilderAvailable: false })
      for (const [route, body] of [['files', undefined], ['files/index.html', undefined], ['chat', {}], ['attach', {}], ['restore', {}], ['reset', {}], ['preview', {}]] as const) {
        expect((await api(user, route, body, base)).status).toBe(503)
      }
      const form = new FormData()
      form.append('ai_workspace_revision', '0')
      expect((await fetch(`${base}/api/uploads/missing/content`, { method: 'PUT', headers: headers(user, base), body: form })).status).toBe(503)
      await create(user, { 'index.html': html }, {}, base)
    }
    expect(row(user)).toBeUndefined()
    expect(existsSync(root(user))).toBe(false)
    expect((await control('state')).requests.length).toBe(count)
  })

  it('A2: only live registered accounts qualify in restricted and open mode', async () => {
    for (const base of [getBaseUrl(), env.JOLT_TEST_OPEN_URL!]) {
      const user = await account(base)
      const webLanding = await fetch(env.JOLT_TEST_OPEN_URL!)
      const webCookie = webLanding.headers.get('set-cookie')!.split(';')[0]!
      const tokenResponse = await fetch(`${getBaseUrl()}/api/admin/tokens`, {
        method: 'POST', headers: { Cookie: admin, 'Content-Type': 'application/json' },
        body: jsonBody({ nickname: `ai-token-${randomUUID()}`, user_id: user.id }),
      })
      expect(tokenResponse.status).toBe(200)
      const token = (await tokenResponse.json()).token
      const site = await create(user, { 'index.html': html }, { password: 'auth-site' })
      const unlocked = await siteRequest(site.slug!, '/_jolt/unlock', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=auth-site' })
      expect(unlocked.status).toBe(303)
      const view = `jolt_view=${cookieValue(unlocked, 'jolt_view')}`
      for (const extra of [{}, { Cookie: webCookie }, { Authorization: `Bearer ${token}` }, { Cookie: view }, { Cookie: `owner_token=${site.owner_token}` }, { Cookie: admin }]) {
        for (const [route, body] of [
          ['files', undefined], ['files/index.html', undefined],
          ['chat', { message: 'unauthenticated', revision: 0 }],
          ['attach', { slug: site.slug, revision: 0 }],
          ['reset', { revision: 0 }], ['restore', { revision: 0 }], ['preview', { revision: 0 }],
        ] as const) expect((await api(undefined, route, body, base, extra)).status).toBe(401)
        const form = new FormData()
        form.append('ai_workspace_revision', '0')
        expect((await fetch(`${base}/api/uploads/${site.slug}/content`, { method: 'PUT', headers: headers(undefined, base, extra), body: form })).status).toBe(401)
      }
      expect((await api(user, 'files', undefined, base)).status).toBe(200)
      expect((await api(user, 'reset', { revision: 0 }, base, { Origin: 'https://foreign.invalid' })).status).toBe(403)
      const marker = await queued({ content: manifest([add('index.html', html)]) })
      expect((await api(user, 'chat', { message: marker, revision: 0 }, base)).status).toBe(200)
      await fetch(`${base}/api/admin/users/${user.id}/delete`, { method: 'POST', headers: { Cookie: admin } }).then(res => expect(res.status).toBe(200))
      expect((await api(user, 'files', undefined, base)).status).toBe(401)
    }
    expect((await siteRequest('ai-unavailable', '/api/ai/files')).status).toBe(404)
  })

  it('A3: chat files persist across login and subsequent prompts contain actual current bytes', async () => {
    const user = await account()
    await seed(user)
    const first = await state(user)
    expect(first).toMatchObject({ revision: 1, editable_files: 3, editable_bytes: Buffer.byteLength(html) + Buffer.byteLength('body { color: red; }') + Buffer.byteLength('console.log("old")') })
    const read = await api(user, 'files/index.html')
    expect(read.headers.get('content-type')).toContain('application/json')
    expect(await read.json()).toEqual({ path: 'index.html', content: html, bytes: Buffer.byteLength(html), revision: 1 })
    const login = await fetch(`${getBaseUrl()}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: jsonBody({ email: user.email, password }) })
    user.cookie = login.headers.get('set-cookie')!.split(';')[0]!
    expect(await state(user)).toEqual(first)
    const next = await chat(user, [update('index.html', '<html>Changed</html>'), remove('old.js'), add('new.js', 'new script')])
    expect(next.response.status).toBe(200)
    expect((await state(user)).files.map(file => file.path).sort()).toEqual(['index.html', 'new.js', 'style.css'])
    const captured = (await control('state')).requests.find(request => request.marker === next.marker)!
    const context = captured.body.messages.find(message => message.content.includes('<current_workspace>'))!
    expect(context.content).toContain(html)
    expect(context.content).toContain('console.log')
    expect(context.content).toContain('body { color: red; }')
    const third = await chat(user, [update('style.css', 'body { color: blue; }')])
    expect(third.response.status).toBe(200)
    const latest = (await control('state')).requests.find(request => request.marker === third.marker)!
    const current = latest.body.messages.find(message => message.content.includes('<current_workspace>'))!
    expect(current.content).toContain('<html>Changed</html>')
    expect(current.content).toContain('new script')
    expect(current.content).not.toContain('old.js')
  })

  it('A4: representative invalid protocol and path families are atomic', async () => {
    const user = await account()
    await seed(user)
    const invalid: unknown[] = [
      manifest([{ op: 'rename', path: 'index.html' }]), { ...manifest([update('index.html', html)]), unknown: true },
      manifest([update('index.html', 123)]), '```json\n{}\n```', 'not-json',
      manifest([remove('index.html')]), manifest([add('x.txt', 'x'), add('x.txt', 'y')]),
      manifest([update('absent.txt', 'x')]), manifest([remove('absent.txt')]), manifest([add('index.html', 'x')]),
      manifest([add('bad.txt', '\u0000')]), manifest([add('bad.txt', '\ud800')]),
      ...['../escape.html', '.generations/x.html', 'INDEX.HTML', 'style.css/x.txt', '/absolute.html', 'bad%2fpath.html'].map(path => manifest([add(path, 'x')])),
    ]
    for (const content of invalid) {
      await unchanged(user, async () => {
        const marker = await queued({ content })
        return api(user, 'chat', { message: marker, revision: 1 })
      })
    }
    await unchanged(user, async () => {
      const marker = await queued({ envelope: { choices: [] } })
      return api(user, 'chat', { message: marker, revision: 1 })
    })
  })

  it('A5: inclusive quotas, accounting, private reads and hosted path isolation', async () => {
    const user = await account()
    const files = [add('index.html', 'x'.repeat(1024 * 1024)), ...Array.from({ length: 4 }, (_, i) => add(`big${i}.txt`, 'x'.repeat(1024 * 1024 - 45))), ...Array.from({ length: 45 }, (_, i) => add(`small${i}.txt`, 'xxxx'))]
    expect((await chat(user, files)).response.status).toBe(200)
    expect(await state(user)).toMatchObject({ editable_files: 50, editable_bytes: 5 * 1024 * 1024 })
    for (const operations of [[add('extra.txt', 'x')], [update('index.html', 'x'.repeat(1024 * 1024 + 1))], [update('big0.txt', 'x'.repeat(1024 * 1024 - 44))]]) {
      await unchanged(user, async () => (await chat(user, operations)).response)
    }
    expect((await chat(user, [remove('small0.txt'), update('big0.txt', 'x'.repeat(1024 * 1024 - 41))])).response.status).toBe(200)
    const other = await account()
    expect((await api(other, 'files/index.html')).status).toBe(404)
    for (const path of ['%2e%2e%2findex.html', '.generations/metadata.json', '%00index.html']) expect([400, 404]).toContain((await api(user, `files/${path}`)).status)
    const site = await create(user, { 'index.html': html })
    for (const path of [`/.workspaces/${user.id}/.generations/${row(user).current_generation}/content/index.html`, '/.staging/index.html', '/metadata.json', '/.pre-edit-snapshot/index.html']) {
      expect((await siteRequest(site.slug!, path)).status).toBe(404)
      const app = await fetch(`${getBaseUrl()}${path}`)
      expect(await app.text()).not.toContain('x'.repeat(1000))
    }
  }, 30000)

  it('A6: oversized declared/chunked bodies and malformed input never call the provider', async () => {
    const user = await account()
    const count = (await control('state')).requests.length
    const body = jsonBody({ message: '😀'.repeat(3000), revision: 0 })
    for (const extra of [{ 'content-length': String(Buffer.byteLength(body)) }, { 'transfer-encoding': 'chunked' }]) {
      const response = await rawRequest({ method: 'POST', path: '/api/ai/chat', hostHeader: new URL(getBaseUrl()).host, headers: headers(user, getBaseUrl(), { 'content-type': 'application/json', ...extra }), body })
      expect(response.status).toBe(413)
    }
    for (const body of ['{', jsonBody({ message: 'x', revision: 0, extra: true })]) {
      expect((await fetch(`${getBaseUrl()}/api/ai/chat`, { method: 'POST', headers: headers(user, getBaseUrl(), { 'Content-Type': 'application/json' }), body })).status).toBe(400)
    }
    expect((await control('state')).requests.length).toBe(count)
    expect(row(user)).toBeUndefined()
  })

  it('A7: exact cost pairs, missing usage and safe errors are stored with UTF-8 bounds', async () => {
    const user = await account()
    const first = await seed(user)
    const result = await first.response.json()
    const pair = sql.prepare<[string], AiMessageRow>('SELECT * FROM ai_messages WHERE turn_id = ? ORDER BY role DESC').all(result.turn_id)
    expect(pair.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(pair[0]).toMatchObject({ model: null, input_tokens: null, output_tokens: null, duration_ms: null, status: 'ok' })
    expect(pair[1]).toMatchObject({ model: 'integration-returned-model', input_tokens: 17, output_tokens: 23, duration_ms: result.usage.duration_ms, status: 'ok' })
    expect((await chat(user, [update('index.html', html)], { usage: null })).response.status).toBe(200)
    const unicodeMarker = await queued({ envelope: { choices: [{ finish_reason: 'stop', message: { content: jsonBody(manifest([update('index.html', html)])) } }] } })
    const unicodeMessage = `${unicodeMarker} ${'😀'.repeat(1500)}`
    const unicodeResponse = await api(user, 'chat', { message: unicodeMessage, revision: 2 })
    expect(unicodeResponse.status).toBe(200)
    const unicodeResult = await unicodeResponse.json()
    const storedUser = sql.prepare<[string], { bytes: number; content: string }>("SELECT content, length(CAST(content AS BLOB)) AS bytes FROM ai_messages WHERE turn_id = ? AND role = 'user'").get(unicodeResult.turn_id)!
    expect(storedUser.content).toBe(unicodeMessage)
    expect(storedUser.bytes).toBe(Buffer.byteLength(unicodeMessage))
    expect(storedUser.bytes).toBeGreaterThan(unicodeMessage.length)
    expect(unicodeResult.usage).toMatchObject({ model: env.JOLT_AI_MODEL, input_tokens: null, output_tokens: null })
    await unchanged(user, async () => (await chat(user, [], { content: 'RAW_PROVIDER_SECRET' })).response)
    await unchanged(user, async () => (await chat(user, [], { kind: 'raw', status: 503, body: 'RAW_PROVIDER_SECRET' })).response)
    const messages = sql.prepare<[string], AiMessageRow & { bytes: number }>('SELECT *, length(CAST(content AS BLOB)) AS bytes FROM ai_messages WHERE user_id = ?').all(user.id)
    expect(messages.find(message => message.role === 'assistant' && message.turn_id === unicodeResult.turn_id)).toMatchObject({ status: 'ok', model: env.JOLT_AI_MODEL, input_tokens: null, output_tokens: null })
    expect(messages.filter(message => message.status === 'error').length).toBe(4)
    for (const message of messages) {
      expect(message.bytes).toBeLessThanOrEqual(16384)
      expect(message.content).not.toContain('RAW_PROVIDER_SECRET')
      expect(message.content).not.toContain(env.JOLT_AI_API_KEY)
    }
  })

  it('A8: deterministic held turns enforce per-account guards and stale revision rejection', async () => {
    const user = await account()
    const other = await account()
    const site = await create(user)
    expect((await attach(user, site.slug!)).status).toBe(200)
    const marker = await queued({ kind: 'hold', content: manifest([update('index.html', '<html>held</html>')]) })
    const pending = api(user, 'chat', { message: marker, revision: 1 })
    await control('wait', { marker })
    for (const route of ['chat', 'attach', 'reset', 'restore', 'preview']) {
      const body = route === 'chat' ? { message: 'busy', revision: 1 } : route === 'attach' ? { slug: site.slug, revision: 1 } : { revision: 1 }
      expect((await api(user, route, body)).status).toBe(409)
    }
    expect((await publish(user, site.slug!)).status).toBe(409)
    await seed(other)
    await control('release', { marker })
    expect((await pending).status).toBe(200)
    await unchanged(user, () => api(user, 'chat', { message: 'stale', revision: 1 }), 409)
    await unchanged(user, async () => {
      const failedMarker = await queued({ kind: 'hold', content: manifest([update('index.html', 'must not apply')]) })
      const failedPending = api(user, 'chat', { message: failedMarker, revision: 2 })
      await control('wait', { marker: failedMarker })
      expect((await api(user, 'reset', { revision: 2 })).status).toBe(409)
      await control('release', { marker: failedMarker, response: { kind: 'raw', body: 'provider secret', status: 500 } })
      return failedPending
    })
    expect((await chat(user, [update('index.html', html)])).response.status).toBe(200)
    expect((await control('state')).requests.filter(request => request.marker === marker)).toHaveLength(1)
  })

  it('A9: all accepted failures spend the 30-attempt budget; overflow/truncation/tools/timeout are atomic', async () => {
    const user = await account()
    const started = (await control('state')).requests.length
    await seed(user)
    for (const spec of [{ kind: 'overflow' }, { finish_reason: 'length' }, { tool_calls: [{ id: 'tool', type: 'function', function: { name: 'no', arguments: '{}' } }] }, { kind: 'raw', body: '{' }]) {
      await unchanged(user, async () => (await chat(user, [update('index.html', 'bad')], spec)).response)
    }
    await unchanged(user, async () => (await chat(user, [], { kind: 'timeout' })).response, 504)
    for (let i = 6; i < 30; i++) await unchanged(user, async () => (await chat(user, [], { kind: 'raw', status: 500, body: '{}' })).response)
    const count = (await control('state')).requests.length
    expect(count - started).toBe(30)
    const timeout = sql.prepare<[string], AiMessageRow>("SELECT * FROM ai_messages WHERE user_id = ? AND role = 'assistant' AND error_code = 'provider_timeout'").get(user.id)
    expect(timeout).toMatchObject({ status: 'error', model: null, input_tokens: null, output_tokens: null })
    expect(timeout!.duration_ms).toBeGreaterThanOrEqual(60000)
    const limited = await api(user, 'chat', { message: '31st attempt', revision: 1 })
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await control('state')).requests.length).toBe(count)
  }, 90000)

  it('A10: orphan stages/generations are ignored and post-provider staging/CAS failure is atomic', async () => {
    const user = await account()
    await seed(user)
    const orphan = join(root(user), '.generations', randomUUID())
    mkdirSync(join(orphan, 'content'), { recursive: true })
    writeFileSync(join(orphan, 'content', 'index.html'), 'uncommitted')
    const stage = join(root(user), '.staging', randomUUID())
    mkdirSync(stage, { recursive: true })
    writeFileSync(join(stage, 'index.html'), 'uncommitted')
    expect(await (await api(user, 'files/index.html')).json()).toMatchObject({ content: html, revision: 1 })
    const marker = await queued({ kind: 'hold', content: manifest([update('index.html', 'lost CAS')]) })
    const pending = api(user, 'chat', { message: marker, revision: 1 })
    await control('wait', { marker })
    sql.prepare('UPDATE ai_workspaces SET revision = revision + 1 WHERE user_id = ?').run(user.id)
    const bytes = committed(user)
    await control('release', { marker })
    expect((await pending).status).toBe(409)
    expect(committed(user)).toEqual(bytes)
    expect((await state(user)).revision).toBe(2)
    const marker2 = await queued({ kind: 'hold', content: manifest([update('index.html', 'write failure')]) })
    const pending2 = api(user, 'chat', { message: marker2, revision: 2 })
    await control('wait', { marker: marker2 })
    rmSync(join(root(user), '.staging'), { recursive: true, force: true })
    writeFileSync(join(root(user), '.staging'), 'not a directory')
    await control('release', { marker: marker2 })
    expect((await pending2).status).toBe(500)
    expect(committed(user)).toEqual(bytes)
    expect((await state(user)).revision).toBe(2)
    rmSync(join(root(user), '.staging'))
  })

  it('A11: deleting an account during a held turn cannot recreate its workspace', async () => {
    const user = await account()
    const other = await account()
    await seed(other)
    const marker = await queued({ kind: 'hold', content: manifest([add('index.html', html)]) })
    const pending = api(user, 'chat', { message: marker, revision: 0 })
    await control('wait', { marker })
    const deletion = await fetch(`${getBaseUrl()}/api/admin/users/${user.id}/delete`, { method: 'POST', headers: { Cookie: admin } })
    expect(deletion.status).toBe(200)
    await control('release', { marker })
    expect((await pending).status).not.toBe(200)
    expect(row(user)).toBeUndefined()
    expect(existsSync(root(user))).toBe(false)
    expect(sql.prepare('SELECT * FROM ai_messages WHERE user_id = ?').all(user.id)).toEqual([])
    const site = await create(other, { 'index.html': html })
    sql.prepare("UPDATE uploads SET expires_at = '2000-01-01' WHERE slug = ?").run(site.slug)
    expect((await siteRequest(site.slug!, '/')).status).toBe(404)
    expect(await (await api(other, 'files/index.html')).json()).toMatchObject({ content: html })
    const unrelated = await account()
    const unrelatedSite = await create(unrelated, { 'index.html': html })
    const before = await state(other)
    const deletionResponse = await fetch(`${getBaseUrl()}/api/admin/paste/${unrelatedSite.slug}/delete`, { method: 'POST', headers: { Cookie: admin } })
    expect(deletionResponse.status).toBe(200)
    expect(await state(other)).toEqual(before)
    expect(existsSync(root(other))).toBe(true)
  })

  it('A12: previews publish exact bytes as distinct owned sites and appear in the dashboard', async () => {
    const user = await account()
    await seed(user)
    const firstResponse = await preview(user)
    expect(firstResponse.status).toBe(200)
    const first = await firstResponse.json()
    expect(uploadRow(first.slug).user_id).toBe(user.id)
    expect(await (await siteRequest(first.slug, '/')).text()).toBe(html)
    expect(await (await siteRequest(first.slug, '/style.css')).text()).toBe('body { color: red; }')
    expect((await chat(user, [update('index.html', '<html>Second preview</html>')])).response.status).toBe(200)
    const secondResponse = await preview(user)
    expect(secondResponse.status).toBe(200)
    const second = await secondResponse.json()
    expect(second.slug).not.toBe(first.slug)
    expect(await (await siteRequest(second.slug, '/')).text()).toBe('<html>Second preview</html>')
    expect(await (await siteRequest(first.slug, '/')).text()).toBe(html)
    const listed = await fetch(`${getBaseUrl()}/api/user/uploads?limit=100`, { headers: { Cookie: user.cookie } }).then(res => res.json())
    expect(listed.items.map((item: { slug: string }) => item.slug).sort()).toEqual([first.slug, second.slug].sort())
  })

  it('A13: preview archives exclude private state and preserve canonical password behavior', async () => {
    const user = await account()
    await seed(user)
    const response = await preview(user, { password: 'site-secret', enable_data: true })
    expect(response.status).toBe(200)
    const site = await response.json()
    expect(site.url_with_unlock).toMatch(new RegExp(`^http://${site.slug}\\.sites\\.localhost:`))
    expect(site.owner_token).toBeTruthy()
    expect(site.url_with_owner_token).toBeUndefined()
    const files = readdirSync(join(storage, site.slug))
    expect(files.sort()).toEqual(['index.html', 'old.js', 'style.css'])
    expect((await siteRequest(site.slug, '/')).status).not.toBe(200)
    const unlocked = await siteRequest(site.slug, '/_jolt/unlock', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=site-secret' })
    expect(unlocked.status).toBe(303)
    expect(await (await siteRequest(site.slug, '/', { cookie: `jolt_view=${cookieValue(unlocked, 'jolt_view')}` })).text()).toBe(html)
    const count = sql.prepare('SELECT count(*) AS n FROM uploads WHERE user_id = ?').get(user.id)
    expect((await preview(user, { enable_data: true })).status).toBe(400)
    expect(sql.prepare('SELECT count(*) AS n FROM uploads WHERE user_id = ?').get(user.id)).toEqual(count)
  })

  it('A14: preview policy failures leave no rows/files, including CAPTCHA, size, data, hosting and rate', async () => {
    const user = await account()
    await seed(user)
    const before = readdirSync(storage).sort()
    for (const [base, options, status] of [
      [getBaseUrl(), { expiration: 'bad' }, 400], [getBaseUrl(), { password: 'x'.repeat(201) }, 400],
      [getBaseUrl(), { unknown: true }, 400], [env.JOLT_TEST_CAPTCHA_URL, {}, 400],
      [env.JOLT_TEST_NO_DATA_URL, { password: 'secret', enable_data: true }, 403],
      [env.JOLT_TEST_NO_HOST_URL, {}, 503],
      [env.JOLT_TEST_NO_DATA_SECRET_URL, { password: 'secret', enable_data: true }, 503],
    ] as Array<[string, Record<string, unknown>, number]>) {
      expect((await preview(user, options, base)).status).toBe(status)
    }
    sql.prepare('UPDATE users SET upload_max_bytes = 1 WHERE id = ?').run(user.id)
    expect((await preview(user)).status).toBe(413)
    sql.prepare('UPDATE users SET upload_max_bytes = NULL WHERE id = ?').run(user.id)
    const fixed = { 'cf-connecting-ip': '10.95.99.99' }
    for (let i = 0; i < 25; i++) expect((await preview(user, { expiration: 'bad' }, getBaseUrl(), fixed)).status).toBe(400)
    const limited = await preview(user, {}, getBaseUrl(), fixed)
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(sql.prepare('SELECT * FROM uploads WHERE user_id = ?').all(user.id)).toEqual([])
    expect(readdirSync(storage).sort()).toEqual(before)
  })

  it('A15: ordinary upload/multipart replacement remain compatible alongside builder publication', async () => {
    const user = await account()
    const site = await create(user, { 'nested/index.html': html, 'nested/style.css': 'nested css' })
    const before = uploadRow(site.slug!)
    const form = new FormData()
    form.append('file', toBlob(await zip({ 'nested/index.html': '<html>ordinary replacement</html>', 'nested/style.css': 'new css' })), 'replacement.zip')
    const response = await fetch(`${getBaseUrl()}/api/uploads/${site.slug}/content`, { method: 'PUT', headers: headers(user), body: form })
    expect(response.status).toBe(200)
    expect(await (await siteRequest(site.slug!, '/')).text()).toBe('<html>ordinary replacement</html>')
    expect(uploadRow(site.slug!).id).toBe(before.id)
    expect(uploadRow(site.slug!).user_id).toBe(user.id)
  })

  it('A16: attach seeds owned text/binary without provider calls; authorization includes registered admins only', async () => {
    const owner = await account()
    const other = await account()
    const site = await create(owner)
    const count = (await control('state')).requests.length
    const attached = await attach(owner, site.slug!)
    expect(attached.status).toBe(200)
    expect(await attached.json()).toMatchObject({ revision: 1, opaque_files: 1, editable_files: 2, target: { slug: site.slug }, restore_available: true })
    expect(await (await api(owner, 'files/index.html')).json()).toMatchObject({ content: html })
    expect(row(owner).snapshot_dir).toBeTruthy()
    expect(existsSync(join(root(owner), row(owner).snapshot_dir))).toBe(true)
    expect((await attach(other, site.slug!)).status).toBe(403)
    expect((await api(undefined, 'attach', { slug: site.slug, revision: 0 }, getBaseUrl(), { Cookie: admin })).status).toBe(401)
    other.cookie = `${other.cookie}; ${admin}`
    expect((await attach(other, site.slug!)).status).toBe(200)
    const anonymous = await create(undefined, { 'index.html': html }, {}, env.JOLT_TEST_OPEN_URL)
    expect((await api(owner, 'attach', { slug: anonymous.slug, revision: 1 }, getBaseUrl(), { Cookie: `${owner.cookie}; owner_token=${anonymous.owner_token}` })).status).toBe(403)
    expect((await control('state')).requests.length).toBe(count)
    expect(sql.prepare('SELECT * FROM uploads WHERE slug = ?').all(site.slug)).toHaveLength(1)
  })

  it('A17: attachment quotas and unsafe sources fail without disturbing an existing session/snapshot', async () => {
    const user = await account()
    const first = await create(user)
    expect((await attach(user, first.slug!)).status).toBe(200)
    const sourceCases = [
      { 'index.html': 'x'.repeat(1024 * 1024 + 1) },
      Object.fromEntries([['index.html', html], ...Array.from({ length: 50 }, (_, i) => [`${i}.txt`, 'x'])]),
      Object.fromEntries([['index.html', html], ...Array.from({ length: 5 }, (_, i) => [`${i}.txt`, 'x'.repeat(1024 * 1024)])]),
    ]
    for (const files of sourceCases) {
      const site = await create(user, files)
      const response = await unchanged(user, () => attach(user, site.slug!), 413)
      expect(await response.text()).toMatch(/limit|MiB|files|bytes/i)
    }
    const bad = await create(user)
    const liveRoot = join(storage, uploadRow(bad.slug!).entry_point, '..')
    symlinkSync(join(storage, first.slug!, 'index.html'), join(liveRoot, 'linked.txt'))
    await unchanged(user, () => attach(user, bad.slug!), 400)
    rmSync(join(liveRoot, 'linked.txt'))
    const fifo = join(liveRoot, 'pipe.txt')
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0)
    await unchanged(user, () => attach(user, bad.slug!), 400)
    rmSync(fifo)
    writeFileSync(join(liveRoot, '.private.txt'), 'unsafe source path')
    await unchanged(user, () => attach(user, bad.slug!), 400)
    const allowed = await create(user, { 'index.html': html, 'binary.txt': binary })
    expect((await attach(user, allowed.slug!)).status).toBe(200)
    expect((await state(user)).opaque_files).toBe(1)
  }, 30000)

  it('A18: opaque assets are absent from prompt context, immutable and retained across generations/publication', async () => {
    const user = await account()
    const site = await create(user)
    expect((await attach(user, site.slug!)).status).toBe(200)
    expect((await api(user, 'files/image.png')).status).toBe(403)
    for (const operation of [add('image.png', 'x'), update('image.png', 'x'), remove('image.png'), add('IMAGE.PNG', 'x'), add('image.png/child.txt', 'x')]) await unchanged(user, async () => (await chat(user, [operation])).response)
    const result = await chat(user, [update('index.html', '<html>opaque preserved</html>')])
    expect(result.response.status).toBe(200)
    const captured = (await control('state')).requests.find(request => request.marker === result.marker)!
    const context = captured.body.messages.find(message => message.content.includes('<current_workspace>'))!
    expect(context.content).not.toContain('image.png')
    expect(committed(user)['image.png']).toBe(hash(binary))
    expect((await publish(user, site.slug!)).status).toBe(200)
    expect(hash(readFileSync(join(storage, uploadRow(site.slug!).entry_point, '..', 'image.png')))).toBe(hash(binary))
    const served = await rawRequest({ path: '/image.png', hostHeader: `${site.slug}.${SITE_BASE_HOSTNAME}:${serverPort()}` })
    expect(served.status).toBe(200)
    expect(served.bytes).toEqual(binary)
  })

  it('A19: builder replacement preserves immutable settings and the site-data database', async () => {
    const user = await account()
    const site = await create(user, undefined, { password: 'protected', enable_data: 'true', title: 'Keep title', expiration: '24h' })
    const before = uploadRow(site.slug!)
    const login = await siteRequest(site.slug!, '/_jolt/data/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=protected' })
    expect(login.status).toBe(303)
    const cookie = cookieHeader(`jolt_view=${cookieValue(login, 'jolt_view')}`, `jolt_data=${cookieValue(login, 'jolt_data')}`)
    const record = await siteRequest(site.slug!, '/_jolt/data/v1/collections/notes/items', { method: 'POST', cookie, headers: { 'Content-Type': 'application/json' }, body: jsonBody({ value: { text: 'preserved record' } }) })
    expect(record.status).toBe(201)
    const createdRecord = await record.json<{ id: string; value: { text: string } }>()
    const dbBytes = readFileSync(dbFileFor(before.id))
    expect((await attach(user, site.slug!)).status).toBe(200)
    expect((await chat(user, [update('index.html', '<html>replacement</html>'), remove('old.js')])).response.status).toBe(200)
    const response = await publish(user, site.slug!)
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result).toMatchObject({ slug: site.slug, url: site.url })
    expect(result.owner_token).toBeUndefined()
    const after = uploadRow(site.slug!)
    expect({ ...after, entry_point: before.entry_point }).toEqual(before)
    expect(readFileSync(dbFileFor(before.id))).toEqual(dbBytes)
    const records = await siteRequest(site.slug!, '/_jolt/data/v1/collections/notes/items', { cookie })
    expect(records.status).toBe(200)
    expect(await records.json()).toMatchObject({ items: [{ id: createdRecord.id, value: { text: 'preserved record' } }] })
    expect(await (await siteRequest(site.slug!, '/', { cookie })).text()).toBe('<html>replacement</html>')
    expect((await siteRequest(site.slug!, '/old.js', { cookie })).status).toBe(404)
    expect(hash(readFileSync(join(storage, after.entry_point, '..', 'image.png')))).toBe(hash(binary))
  })

  it('A20: restore is local until explicit publication; reset closes snapshots but retains costs', async () => {
    const user = await account()
    const site = await create(user)
    expect((await attach(user, site.slug!)).status).toBe(200)
    const snapshot = row(user).snapshot_dir
    expect((await chat(user, [update('index.html', '<html>edited</html>'), remove('old.js')])).response.status).toBe(200)
    expect((await publish(user, site.slug!)).status).toBe(200)
    sql.prepare("UPDATE uploads SET title = 'current title', expires_at = '2099-01-01' WHERE slug = ?").run(site.slug)
    expect((await api(user, 'restore', { revision: 2 })).status).toBe(200)
    expect((await state(user)).revision).toBe(3)
    expect(await (await api(user, 'files/index.html')).json()).toMatchObject({ content: html })
    expect(await (await siteRequest(site.slug!, '/')).text()).toBe('<html>edited</html>')
    expect((await publish(user, site.slug!)).status).toBe(200)
    expect(await (await siteRequest(site.slug!, '/')).text()).toBe(html)
    expect(await (await siteRequest(site.slug!, '/old.js')).text()).toBe('original script')
    expect(uploadRow(site.slug!)).toMatchObject({ title: 'current title', expires_at: '2099-01-01' })
    expect((await siteRequest(site.slug!, `/${snapshot}/content/index.html`)).status).toBe(404)
    expect((await api(user, 'reset', { revision: 3 })).status).toBe(200)
    expect(await state(user)).toMatchObject({ revision: 4, files: [], target: null, restore_available: false })
    expect(existsSync(join(root(user), snapshot))).toBe(false)
    expect(sql.prepare('SELECT * FROM ai_messages WHERE user_id = ?').all(user.id)).toHaveLength(2)
    const result = await chat(user, [add('index.html', '<html>new session</html>')])
    expect(result.response.status).toBe(200)
    const capture = (await control('state')).requests.find(request => request.marker === result.marker)!
    expect(JSON.stringify(capture.body.messages)).not.toContain('<html>edited</html>')
    expect(JSON.stringify(capture.body.messages)).not.toContain('original script')
  })

  it('A21: deleted/expired/reowned targets and external replacement cannot be overwritten', async () => {
    for (const mutation of ['deleted', 'expired', 'reowned']) {
      const user = await account()
      const other = await account()
      const site = await create(user)
      expect((await attach(user, site.slug!)).status).toBe(200)
      if (mutation === 'deleted') sql.prepare('DELETE FROM uploads WHERE slug = ?').run(site.slug)
      if (mutation === 'expired') sql.prepare("UPDATE uploads SET expires_at = '2000-01-01' WHERE slug = ?").run(site.slug)
      if (mutation === 'reowned') sql.prepare('UPDATE uploads SET user_id = ? WHERE slug = ?').run(other.id, site.slug)
      const status = mutation === 'reowned' ? 403 : 404
      await unchanged(user, () => api(user, 'chat', { message: 'must not call', revision: 1 }), status)
      await unchanged(user, () => api(user, 'restore', { revision: 1 }), status)
      await unchanged(user, () => publish(user, site.slug!), status)
      expect((await api(user, 'reset', { revision: 1 })).status).toBe(200)
    }
    const user = await account()
    const site = await create(user)
    expect((await attach(user, site.slug!)).status).toBe(200)
    const form = new FormData()
    form.append('file', new Blob(['<html>external replacement</html>']), 'index.html')
    expect((await fetch(`${getBaseUrl()}/api/uploads/${site.slug}/content`, { method: 'PUT', headers: headers(user), body: form })).status).toBe(200)
    await unchanged(user, () => publish(user, site.slug!), 409)
    expect(await (await siteRequest(site.slug!, '/')).text()).toBe('<html>external replacement</html>')
  })

  it('A22: nested, nondefault HTML and Markdown entry semantics survive attach and publish', async () => {
    const user = await account()
    const nested = await create(user, { 'wrapper/site/index.html': html, 'wrapper/site/style.css': 'nested', 'wrapper/outside.txt': 'outside root' })
    expect((await attach(user, nested.slug!)).status).toBe(200)
    expect((await state(user)).files.map(file => file.path).sort()).toEqual(['index.html', 'style.css'])
    expect((await chat(user, [update('index.html', '<html>nested edit</html>')])).response.status).toBe(200)
    expect((await publish(user, nested.slug!)).status).toBe(200)
    expect(await (await siteRequest(nested.slug!, '/')).text()).toBe('<html>nested edit</html>')
    expect(await (await siteRequest(nested.slug!, '/style.css')).text()).toBe('nested')
    const multiple = await create(user, { 'index.html': html, 'selected.html': '<html>Selected</html>', 'style.css': 'selected css' })
    sql.prepare('UPDATE uploads SET entry_point = ? WHERE slug = ?').run(`${multiple.slug}/selected.html`, multiple.slug)
    expect((await attach(user, multiple.slug!)).status).toBe(200)
    expect((await state(user)).entry_file).toBe('selected.html')
    expect((await chat(user, [update('selected.html', '<html>Selected edit</html>')])).response.status).toBe(200)
    expect((await publish(user, multiple.slug!)).status).toBe(200)
    expect(uploadRow(multiple.slug!).entry_point).toMatch(/selected\.html$/)
    expect(await (await siteRequest(multiple.slug!, '/')).text()).toBe('<html>Selected edit</html>')
    const form = new FormData()
    form.append('file', new Blob(['# Original Markdown\n\nhello']), 'readme.md')
    const uploaded = await fetch(`${getBaseUrl()}/api/upload`, { method: 'POST', headers: headers(user), body: form })
    expect(uploaded.status).toBe(200)
    const markdown = await uploaded.json()
    expect((await attach(user, markdown.slug)).status).toBe(200)
    const entry = (await state(user)).entry_file
    expect(entry).toMatch(/\.md$/)
    expect((await chat(user, [update(entry, '# Changed Markdown\n\nupdated')])).response.status).toBe(200)
    expect((await publish(user, markdown.slug)).status).toBe(200)
    expect(await (await siteRequest(markdown.slug, '/')).text()).toContain('Changed Markdown')
    const publicForm = new FormData()
    publicForm.append('file', toBlob(await zip({ 'only.md': '# not a public ZIP bypass' })), 'markdown.zip')
    expect((await fetch(`${getBaseUrl()}/api/upload`, { method: 'POST', headers: headers(user), body: publicForm })).status).toBe(400)
  })

  it('A23: failed publication retains live bytes/draft/settings; reattach cleans only obsolete private state', async () => {
    const user = await account()
    const first = await create(user)
    const second = await create(user, { 'index.html': '<html>second target</html>', 'image.png': binary })
    expect((await attach(user, first.slug!)).status).toBe(200)
    const oldSnapshot = row(user).snapshot_dir
    const oldGeneration = row(user).current_generation
    expect((await chat(user, [update('index.html', '<html>private draft</html>')])).response.status).toBe(200)
    const live = uploadRow(first.slug!)
    sql.prepare('UPDATE users SET upload_max_bytes = 1 WHERE id = ?').run(user.id)
    await unchanged(user, () => publish(user, first.slug!), 413)
    expect(uploadRow(first.slug!)).toEqual(live)
    expect(await (await siteRequest(first.slug!, '/')).text()).toBe(html)
    sql.prepare('UPDATE users SET upload_max_bytes = NULL WHERE id = ?').run(user.id)
    expect((await attach(user, second.slug!)).status).toBe(200)
    expect(existsSync(join(root(user), oldSnapshot))).toBe(false)
    expect(existsSync(join(root(user), '.generations', oldGeneration))).toBe(false)
    expect(await (await siteRequest(first.slug!, '/')).text()).toBe(html)
    expect(await (await api(user, 'files/index.html')).json()).toMatchObject({ content: '<html>second target</html>' })
    const expired = uploadRow(second.slug!)
    sql.prepare("UPDATE uploads SET expires_at = '2000-01-01' WHERE slug = ?").run(second.slug)
    await unchanged(user, () => publish(user, second.slug!), 404)
    expect(uploadRow(second.slug!)).toEqual({ ...expired, expires_at: '2000-01-01' })
  })

  it('A21/A23: deterministic source-copy and publication races reject stale, expired and reowned targets', async () => {
    // Scoped handler instances provide deterministic preparation seams without
    // adding a test control route or fault switch to the built production server.
    vi.stubGlobal('defineEventHandler', eventHandler)
    vi.stubGlobal('useRuntimeConfig', () => ({ jolthost: { uploadMaxBytes: 25 * 1024 * 1024 }, turnstileSecretKey: '' }))
    const app = createApp()
    const router = createRouter()
    app.use(router)
    const listener = http.createServer(toNodeListener(app))
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('Expected loopback listener')
    const base = `http://127.0.0.1:${address.port}`
    for (const [name, value] of Object.entries({
      JOLT_APP_ORIGIN: base, JOLT_SITE_BASE_ORIGIN: `http://sites.localhost:${address.port}`,
      JOLT_USER_SECRET: 'test-user-secret-value', JOLT_ADMIN_SECRET: 'test-admin-secret-value',
      JOLT_VIEW_SECRET: 'test-view-secret-value', JOLT_DATA_SESSION_SECRET: 'test-data-session-secret-value',
      ENABLE_AI_BUILDER: 'true', JOLT_AI_API_KEY: env.JOLT_AI_API_KEY!,
      JOLT_AI_BASE_URL: env.JOLT_AI_BASE_URL!, JOLT_AI_MODEL: env.JOLT_AI_MODEL!,
    })) vi.stubEnv(name, value)
    try {
      // Nuxt globals and signing secrets must precede route module evaluation.
      const attachHandler = (await import('~/server/api/ai/attach.post')).default
      const publishHandler = (await import('~/server/api/uploads/[slug]/content.put')).default
      const previewHandler = (await import('~/server/api/ai/preview.post')).default
      router.post('/api/ai/attach', attachHandler)
      router.put('/api/uploads/:slug/content', publishHandler)
      router.post('/api/ai/preview', previewHandler)
      const user = await account()
      const other = await account()
      await seed(user)
      vi.stubGlobal('useRuntimeConfig', () => ({ jolthost: { uploadMaxBytes: 25 * 1024 * 1024 }, turnstileSecretKey: 'integration-only-captcha' }))
      const captcha = vi.spyOn(turnstile, 'verifyTurnstileToken').mockResolvedValue(false)
      expect((await preview(user, { 'cf-turnstile-response': 'invalid-integration-token' }, base)).status).toBe(400)
      expect(sql.prepare('SELECT * FROM uploads WHERE user_id = ?').all(user.id)).toEqual([])
      captcha.mockRestore()
      vi.stubGlobal('useRuntimeConfig', () => ({ jolthost: { uploadMaxBytes: 25 * 1024 * 1024 }, turnstileSecretKey: '' }))
      const source = await create(user)
      const originalRead = workspace.readServedSiteFiles
      const sourceSpy = vi.spyOn(workspace, 'readServedSiteFiles').mockImplementation(entry => {
        const copied = originalRead(entry)
        sql.prepare('UPDATE uploads SET entry_point = ? WHERE slug = ?').run(`${source.slug}/changed.html`, source.slug)
        return copied
      })
      await unchanged(user, () => api(user, 'attach', { slug: source.slug, revision: 1 }, base), 409)
      sourceSpy.mockRestore()
      expect(row(user)?.attached_slug).toBeNull()

      for (const race of ['entry', 'expired', 'reowned', 'deleted'] as const) {
        const site = await create(user)
        expect((await attach(user, site.slug!)).status).toBe(200)
        const live = uploadRow(site.slug!)
        const before = committed(user)
        const originalWrite = content.writeUploadContent
        const publicationSpy = vi.spyOn(content, 'writeUploadContent').mockImplementation(async (...args) => {
          const entry = await originalWrite(...args)
          if (race === 'entry') sql.prepare('UPDATE uploads SET entry_point = ? WHERE slug = ?').run(`${site.slug}/external.html`, site.slug)
          if (race === 'expired') sql.prepare("UPDATE uploads SET expires_at = '2000-01-01' WHERE slug = ?").run(site.slug)
          if (race === 'reowned') sql.prepare('UPDATE uploads SET user_id = ? WHERE slug = ?').run(other.id, site.slug)
          if (race === 'deleted') sql.prepare('DELETE FROM uploads WHERE slug = ?').run(site.slug)
          return entry
        })
        const response = await publish(user, site.slug!, base)
        publicationSpy.mockRestore()
        expect(response.status, `${race} preparation race`).toBe(race === 'expired' || race === 'deleted' ? 404 : 409)
        expect(committed(user)).toEqual(before)
        expect(readFileSync(join(storage, live.entry_point), 'utf8')).toBe(html)
        const failedContent = join(storage, '.content', site.slug!)
        expect(existsSync(failedContent) ? readdirSync(failedContent) : []).toEqual([])
        if (race !== 'deleted') {
          const after = uploadRow(site.slug!)
          expect(after.id).toBe(live.id)
          expect(after.password_hash).toBe(live.password_hash)
          expect(after.data_enabled).toBe(live.data_enabled)
          expect(after.owner_token).toBe(live.owner_token)
          expect(after.entry_point).toBe(race === 'entry' ? `${site.slug}/external.html` : live.entry_point)
        }
      }
    } finally {
      vi.restoreAllMocks()
      vi.unstubAllEnvs()
      vi.unstubAllGlobals()
      listener.closeAllConnections()
      await new Promise<void>(resolve => listener.close(() => resolve()))
    }
  })
})
