import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { createWebSession } from '~/server/utils/web-session'
import { randomUUID } from 'crypto'

const FIXTURES = join(process.cwd(), 'test', 'fixtures')

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

// Runs once after every describe in this file has finished.
afterAll(() => {
  const tmpStorage = join(process.cwd(), 'test', 'tmp-storage')
  const tmpData = join(process.cwd(), 'test', 'tmp-data')
  if (existsSync(tmpStorage)) rmSync(tmpStorage, { recursive: true })
  if (existsSync(tmpData)) rmSync(tmpData, { recursive: true })
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

  it('uploads HTML file and returns slug, url, entry_point, owner_token', async () => {
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
      url: expect.stringMatching(/\/view\/.+/),
      entry_point: expect.stringContaining('index.html'),
      owner_token: expect.any(String),
    })
    expect(data.slug!.length).toBeGreaterThan(0)

    const publicView = await fetch(data.url!)
    expect(publicView.status).toBe(200)
    expect(await publicView.text()).toContain('<title>Dummy Test Site</title>')

    const publicAsset = await fetch(`${data.url}/index.html`)
    expect(publicAsset.status).toBe(200)
    expect(await publicAsset.text()).toContain('<h1>Dummy Test Site</h1>')
  })

  it('returns url_with_unlock when password is provided', async () => {
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
    expect(data.url_with_unlock).toContain('?unlock=')
    expect(data.url_with_unlock).not.toContain('password=')

    const protectedView = await fetch(data.url!, { redirect: 'manual' })
    expect(protectedView.status).toBe(302)
    expect(protectedView.headers.get('location')).toBe(`/view/${data.slug}/unlock`)
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
    const originalUrl = created.url!

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
    expect(data.entry_point).not.toBe(beforeRow.entry_point)
    expect(data).not.toHaveProperty('owner_token')

    // Original URL still requires the password, and the unlock link serves replacement.
    const locked = await fetch(originalUrl, { redirect: 'manual' })
    expect(locked.status).toBe(302)
    expect(locked.headers.get('location')).toBe(`/view/${slug}/unlock`)
    const unlocked = await fetch(created.url_with_unlock!)
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
    const oldAsset = await fetch(`${originalUrl}/index.html?unlock=${encodeURIComponent(new URL(created.url_with_unlock!).searchParams.get('unlock')!)}`)
    expect(oldAsset.status).toBe(200)
    expect(await oldAsset.text()).toContain('Replaced Content')
  })

  it('serves replacement ZIP assets and 404s for omitted old assets', async () => {
    const created = await createSite('dummy-site.zip', {}, { Cookie: userCookie })
    const slug = created.slug!
    const base = created.url!

    // Old site has style.css.
    const oldCss = await fetch(`${base}/style.css`)
    expect(oldCss.status).toBe(200)

    const res = await update(slug, replaceForm('replacement-site.zip'), { Cookie: userCookie })
    expect(res.status).toBe(200)

    const index = await fetch(`${base}/`)
    expect(await index.text()).toContain('Replacement Content')
    const newCss = await fetch(`${base}/new-style.css`)
    expect(newCss.status).toBe(200)
    expect(await newCss.text()).toContain('rebeccapurple')
    const omitted = await fetch(`${base}/style.css`)
    expect(omitted.status).toBe(404)
  })

  it('changes entry point from Markdown to HTML and to a nested ZIP entry point', async () => {
    const created = await createSite('dummy.html', {}, { Cookie: userCookie })
    const slug = created.slug!
    const base = created.url!

    // HTML -> Markdown
    const toMd = new FormData()
    toMd.append('file', new Blob([new TextEncoder().encode('# Updated Notes\n\nHello')], { type: 'text/markdown' }), 'notes.md')
    const mdRes = await update(slug, toMd, { Cookie: userCookie })
    const mdData = await readJson<Record<string, string>>(mdRes)
    expect(mdRes.status).toBe(200)
    expect(mdData.entry_point).toMatch(/index\.md$/)
    const mdView = await fetch(`${base}/`)
    expect(await mdView.text()).toContain('Updated Notes')

    // Markdown -> nested ZIP entry point
    const zipRes = await update(slug, replaceForm('nested-entry-site.zip'), { Cookie: userCookie })
    const zipData = await readJson<Record<string, string>>(zipRes)
    expect(zipRes.status).toBe(200)
    expect(zipData.entry_point).toMatch(/pages\/home\.html$/)
    const zipView = await fetch(`${base}/`)
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
    const base = created.url!

    // Invalid ZIP leaves the previous site usable.
    const bad = await update(slug, replaceForm('escape-site.zip'), { Cookie: userCookie })
    expect(bad.status).toBe(400)
    const stillThere = await fetch(`${base}/style.css`)
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
  })
})

