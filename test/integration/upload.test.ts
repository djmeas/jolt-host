import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { createWebSession } from '~/server/utils/web-session'
import { randomUUID } from 'crypto'

const FIXTURES = join(process.cwd(), 'test', 'fixtures')

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

  afterAll(() => {
    const tmpStorage = join(process.cwd(), 'test', 'tmp-storage')
    const tmpData = join(process.cwd(), 'test', 'tmp-data')
    if (existsSync(tmpStorage)) rmSync(tmpStorage, { recursive: true })
    if (existsSync(tmpData)) rmSync(tmpData, { recursive: true })
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

  it('rejects web sessions and API tokens without a registered-user login on every publishing endpoint', async () => {
    const tokenResponse = await fetch(`${getBaseUrl()}/api/admin/tokens`, {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: `test-${randomUUID()}` }),
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
      const unauthenticatedHeaders: Record<string, string>[] = [{ Cookie: cookie }, { Authorization: `Bearer ${token}` }]
      for (const headers of unauthenticatedHeaders) {
        const res = await fetch(`${getBaseUrl()}${path}`, { method: 'POST', headers: { ...headers, ...(path !== '/api/upload' ? { 'Content-Type': 'application/json' } : {}) }, body: body() })
        expect(res.status, `${path} with ${Object.keys(headers)[0]}`).toBe(401)
      }
      const res = await fetch(`${getBaseUrl()}${path}`, { method: 'POST', headers: { Cookie: userCookie, ...(path !== '/api/upload' ? { 'Content-Type': 'application/json' } : {}) }, body: body() })
      expect(res.ok, path).toBe(true)
    }
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
