import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { readFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import http from 'node:http'
import { createWebSession } from '~/server/utils/web-session'
import { randomUUID } from 'crypto'

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
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const url = new URL(getBaseUrl())
  type RawResult = { status: number; headers: http.IncomingHttpHeaders; body: string }
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

    // A 4 KiB+ record is rejected even though the request body is under 8 KiB.
    const bigRecord = jsonBody({ value: { text: 'x'.repeat(5000) } })
    expect(bigRecord.length).toBeLessThan(8192)
    expect((await post('/_jolt/data/v1/collections/todos/items', bigRecord)).status).toBe(413)

    // A body over the 8 KiB bound is rejected before parsing.
    const huge = jsonBody({ value: { text: 'y'.repeat(12_000) } })
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
    for (let i = 0; i < 10; i++) {
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
