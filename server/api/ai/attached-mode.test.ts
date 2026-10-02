import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRouter, type EventHandler } from 'h3'
import Database from 'better-sqlite3'
import {
  APP_ORIGIN,
  REQUESTED_MODEL,
  SITE_ORIGIN,
  TEST_KEY,
  closeHarness,
  createUser,
  startApp,
  userCookieValue,
} from '../../../test/helpers/ai-endpoints'
import {
  deleteUploadBySlug,
  findUploadBySlug,
  getAiWorkspace,
  getAllUploadIds,
  getDbPath,
  getStorageDir,
  insertUpload,
  updateExpirationBySlug,
} from '~/server/utils/db'
import { deleteStorageForSlug } from '~/server/utils/storage'
import { hashPassword } from '~/server/utils/password'
import { createAdminSession } from '~/server/utils/admin-auth'
import {
  applyWorkspaceGeneration,
  deleteWorkspaceForUser,
  getWorkspaceDir,
  readWorkspaceFile,
} from '~/server/utils/ai-workspace'
import { resetAiOperations } from '~/server/utils/ai-rate-limit'
import { resetRateLimitStore } from '~/server/utils/rate-limit'

// Nuxt auto-imported globals must exist before any route module is evaluated,
// which is why the handlers are loaded with a dynamic import inside the test.
vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
vi.stubGlobal('useRuntimeConfig', () => ({
  jolthost: { uploadMaxBytes: 25 * 1024 * 1024 },
  turnstileSecretKey: '',
}))

const session = (userId: string) => `jolt_user=${userCookieValue(userId)}`
const adminSession = () => `jolt_admin=${createAdminSession().value}`

const createdSlugs: string[] = []
const createdUserIds: string[] = []

function rememberUser(userId: string): string {
  createdUserIds.push(userId)
  return userId
}

const LOGO = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe, 0xef])

type SiteFixture = { slug: string; id: string; entryPoint: string; dir: string }

function createSite(options: {
  userId: string | null
  files?: { path: string; data: Buffer }[]
  password?: boolean
  title?: string
  expiresAt?: string | null
  entryRelative?: string
}): SiteFixture {
  const slug = `site-${randomUUID().slice(0, 10)}`
  const dir = join(getStorageDir(), slug)
  mkdirSync(dir, { recursive: true })
  createdSlugs.push(slug)

  const files = options.files ?? [
    { path: 'index.html', data: Buffer.from('<h1>original</h1>') },
    { path: 'styles/site.css', data: Buffer.from('body { color: red }') },
    { path: 'img/logo.png', data: LOGO },
  ]
  for (const file of files) {
    const target = join(dir, ...file.path.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.data)
  }

  const entryRelative = options.entryRelative ?? 'index.html'
  const id = randomUUID()
  insertUpload(
    id,
    slug,
    `${slug}/${entryRelative}`,
    options.password ? hashPassword('site-password') : null,
    `owner-token-${slug}`,
    options.expiresAt ?? null,
    options.userId,
    options.title ?? 'Kept title'
  )
  return { slug, id, entryPoint: `${slug}/${entryRelative}`, dir }
}

function cleanupUploads(): void {
  for (const slug of createdSlugs.splice(0)) {
    try {
      deleteUploadBySlug(slug)
    } catch {
      // Best effort when a test already removed the row.
    }
    try {
      deleteStorageForSlug(slug)
    } catch {
      // Best effort filesystem cleanup of the shared test storage directory.
    }
  }
  for (const userId of createdUserIds.splice(0)) {
    try {
      deleteWorkspaceForUser(userId)
    } catch {
      // Best effort cleanup of private workspace state.
    }
  }
}

async function serveRoutes() {
  const attach = (await import('./attach.post')).default as EventHandler
  const restore = (await import('./restore.post')).default as EventHandler
  const reset = (await import('./reset.post')).default as EventHandler
  const content = (await import('../uploads/[slug]/content.put')).default as EventHandler
  const userUploads = (await import('../user/uploads.get')).default as EventHandler
  const adminUploads = (await import('../admin/uploads.get')).default as EventHandler

  const router = createRouter()
  router.post('/api/ai/attach', attach)
  router.post('/api/ai/restore', restore)
  router.post('/api/ai/reset', reset)
  router.put('/api/uploads/:slug/content', content)
  router.get('/api/user/uploads', userUploads)
  router.get('/api/admin/uploads', adminUploads)
  return { origin: await startApp(router.handler) }
}

type RequestOptions = { cookie?: string | null; origin?: string | null; authorization?: string }

function jsonHeaders(options: RequestOptions): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const cookie = options.cookie === undefined ? null : options.cookie
  if (cookie) headers.cookie = cookie
  const origin = options.origin === undefined ? APP_ORIGIN : options.origin
  if (origin) headers.origin = origin
  if (options.authorization) headers.authorization = options.authorization
  return headers
}

function postJson(
  origin: string,
  path: string,
  body: unknown,
  options: RequestOptions = {}
): Promise<Response> {
  return fetch(`${origin}${path}`, { method: 'POST', headers: jsonHeaders(options), body: JSON.stringify(body) })
}

function putBuilder(
  origin: string,
  slug: string,
  fields: { revision: number | string; token?: string; extra?: [string, string][] },
  options: RequestOptions = {}
): Promise<Response> {
  const form = new FormData()
  form.append('ai_workspace_revision', String(fields.revision))
  if (fields.token) form.append('cf-turnstile-response', fields.token)
  for (const [name, value] of fields.extra ?? []) form.append(name, value)
  const headers = jsonHeaders(options)
  delete headers['content-type']
  return fetch(`${origin}/api/uploads/${slug}/content`, { method: 'PUT', headers, body: form })
}

/** Commits a patch turn directly, as the chat pipeline does after validation. */
function patchWorkspace(userId: string, path: string, content: string): void {
  const workspace = getAiWorkspace(userId)!
  applyWorkspaceGeneration(userId, {
    expectedRevision: workspace.revision,
    expectedGeneration: workspace.current_generation,
    operations: [{ op: 'update', path, content }],
  })
}

function publishedDir(slug: string): string {
  const row = findUploadBySlug(slug)!
  return dirname(join(getStorageDir(), row.entry_point))
}

function attachSite(serverOrigin: string, userId: string, slug: string, revision = 0) {
  return postJson(serverOrigin, '/api/ai/attach', { slug, revision }, { cookie: session(userId) })
}

beforeEach(() => {
  vi.stubEnv('JOLT_APP_ORIGIN', APP_ORIGIN)
  vi.stubEnv('JOLT_SITE_BASE_ORIGIN', SITE_ORIGIN)
  vi.stubEnv('ENABLE_AI_BUILDER', 'true')
  vi.stubEnv('JOLT_AI_API_KEY', TEST_KEY)
  vi.stubEnv('JOLT_AI_BASE_URL', 'http://127.0.0.1:9/v1')
  vi.stubEnv('JOLT_AI_MODEL', REQUESTED_MODEL)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  resetAiOperations()
  resetRateLimitStore()
  cleanupUploads()
  await closeHarness()
})

describe('POST /api/ai/attach', () => {
  it('seeds the live served root, classifies a binary asset, and creates no upload', async () => {
    const userId = rememberUser(createUser())
    const site = createSite({ userId })
    const { origin } = await serveRoutes()
    const uploadsBefore = getAllUploadIds().length

    const response = await attachSite(origin, userId, site.slug)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.revision).toBe(1)
    expect(body.entry_file).toBe('index.html')
    expect(body.target).toEqual({ slug: site.slug, url: `http://${site.slug}.sites.test/` })
    expect(body.restore_available).toBe(true)
    expect(body.editable_files).toBe(2)
    expect(body.opaque_files).toBe(1)
    expect(body.files.map((file: { path: string }) => file.path).sort()).toEqual([
      'img/logo.png',
      'index.html',
      'styles/site.css',
    ])

    const workspace = getAiWorkspace(userId)!
    expect(workspace.attached_slug).toBe(site.slug)
    expect(workspace.attached_upload_id).toBe(site.id)
    expect(workspace.attached_entry_point).toBe(site.entryPoint)
    expect(workspace.snapshot_dir).toMatch(/^\.pre-edit-\d+$/)
    expect(existsSync(join(getWorkspaceDir(userId), workspace.snapshot_dir!))).toBe(true)
    expect(getAllUploadIds().length).toBe(uploadsBefore)
  })

  it('rejects anonymous, admin-only, foreign, and nonanonymous-owner targets', async () => {
    const owner = rememberUser(createUser())
    const other = rememberUser(createUser())
    const owned = createSite({ userId: owner })
    const anonymousSite = createSite({ userId: null })
    const { origin } = await serveRoutes()

    const anonymous = await postJson(origin, '/api/ai/attach', { slug: owned.slug, revision: 0 }, { cookie: null })
    const adminOnly = await postJson(
      origin,
      '/api/ai/attach',
      { slug: owned.slug, revision: 0 },
      { cookie: adminSession() }
    )
    const foreign = await attachSite(origin, other, owned.slug)
    const anonymousOwner = await attachSite(origin, other, anonymousSite.slug)

    expect(anonymous.status).toBe(401)
    expect(adminOnly.status).toBe(401)
    expect(foreign.status).toBe(403)
    expect((await foreign.json()).error.code).toBe('target_forbidden')
    expect(anonymousOwner.status).toBe(403)
    expect(getAiWorkspace(owner)).toBeNull()
  })

  it('rejects a missing or expired site with 404', async () => {
    const userId = rememberUser(createUser())
    const expired = createSite({ userId, expiresAt: '2000-01-01T00:00:00.000Z' })
    const { origin } = await serveRoutes()

    const missing = await attachSite(origin, userId, `nope-${randomUUID().slice(0, 8)}`)
    const gone = await attachSite(origin, userId, expired.slug)

    expect(missing.status).toBe(404)
    expect(gone.status).toBe(404)
    expect((await gone.json()).error.code).toBe('target_unavailable')
  })

  it('lets a registered user with an admin session attach another account’s site', async () => {
    const owner = rememberUser(createUser())
    const admin = rememberUser(createUser())
    const owned = createSite({ userId: owner })
    const { origin } = await serveRoutes()

    const response = await postJson(
      origin,
      '/api/ai/attach',
      { slug: owned.slug, revision: 0 },
      { cookie: `${session(admin)}; ${adminSession()}` }
    )

    expect(response.status).toBe(200)
    expect(getAiWorkspace(admin)?.attached_slug).toBe(owned.slug)
    expect(getAiWorkspace(owner)).toBeNull()
  })

  it('refuses an over-limit editable source atomically', async () => {
    const userId = rememberUser(createUser())
    const files = [{ path: 'index.html', data: Buffer.from('x') }]
    for (let index = 0; index < 50; index += 1) {
      files.push({ path: `page-${index}.html`, data: Buffer.from('x') })
    }
    const site = createSite({ userId, files })
    const { origin } = await serveRoutes()
    const before = getAiWorkspace(userId)

    const response = await attachSite(origin, userId, site.slug)

    expect(response.status).toBe(413)
    expect((await response.json()).error.code).toBe('editable_workspace_too_large')
    expect(getAiWorkspace(userId)).toEqual(before)
  })

  it('rejects a stale revision and unknown body fields', async () => {
    const userId = rememberUser(createUser())
    const site = createSite({ userId })
    const { origin } = await serveRoutes()

    const stale = await attachSite(origin, userId, site.slug, 5)
    const unknown = await postJson(
      origin,
      '/api/ai/attach',
      { slug: site.slug, revision: 0, owner_token: 'anything' },
      { cookie: session(userId) }
    )

    expect(stale.status).toBe(409)
    expect((await stale.json()).error.code).toBe('workspace_conflict')
    expect(unknown.status).toBe(400)
  })

  it('returns 503 before allocating anything when the feature is unavailable', async () => {
    const userId = rememberUser(createUser())
    const site = createSite({ userId })
    const { origin } = await serveRoutes()
    vi.stubEnv('JOLT_AI_API_KEY', '')

    const response = await attachSite(origin, userId, site.slug)

    expect(response.status).toBe(503)
    expect((await response.json()).error.code).toBe('ai_unavailable')
    expect(getAiWorkspace(userId)).toBeNull()
  })
})

describe('PUT /api/uploads/[slug]/content builder mode', () => {
  it('publishes attached text while preserving opaque bytes, identity, and settings', async () => {
    const userId = rememberUser(createUser())
    const site = createSite({ userId, password: true, title: 'Kept title' })
    const { origin } = await serveRoutes()
    expect((await attachSite(origin, userId, site.slug)).status).toBe(200)
    patchWorkspace(userId, 'index.html', '<h1>patched</h1>')

    const workspaceBefore = getAiWorkspace(userId)!
    const rowBefore = findUploadBySlug(site.slug)!
    const uploadsBefore = getAllUploadIds().length

    const response = await putBuilder(origin, site.slug, {
      revision: workspaceBefore.revision,
    }, { cookie: session(userId) })

    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result.slug).toBe(site.slug)
    expect(result.url).toBe(`http://${site.slug}.sites.test/`)
    expect(result).not.toHaveProperty('owner_token')

    const dir = publishedDir(site.slug)
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toBe('<h1>patched</h1>')
    expect(readFileSync(join(dir, 'img/logo.png'))).toEqual(LOGO)
    expect(readFileSync(join(dir, 'styles/site.css'), 'utf8')).toBe('body { color: red }')

    const rowAfter = findUploadBySlug(site.slug)!
    expect(rowAfter.id).toBe(rowBefore.id)
    expect(rowAfter.created_at).toBe(rowBefore.created_at)
    expect(rowAfter.title).toBe(rowBefore.title)
    expect(rowAfter.password_hash).toBe(rowBefore.password_hash)
    expect(rowAfter.owner_token).toBe(rowBefore.owner_token)
    expect(rowAfter.expires_at).toBe(rowBefore.expires_at)
    expect(rowAfter.data_enabled).toBe(rowBefore.data_enabled)
    expect(rowAfter.entry_point).not.toBe(rowBefore.entry_point)
    expect(getAllUploadIds().length).toBe(uploadsBefore)

    // Publication refreshes only the baseline; the editable workspace is untouched.
    const workspaceAfter = getAiWorkspace(userId)!
    expect(workspaceAfter.revision).toBe(workspaceBefore.revision)
    expect(workspaceAfter.current_generation).toBe(workspaceBefore.current_generation)
    expect(workspaceAfter.attached_entry_point).toBe(rowAfter.entry_point)
    expect(workspaceAfter.snapshot_dir).toBe(workspaceBefore.snapshot_dir)
  })

  it('preserves a Markdown-only entry and a nondefault HTML entry when publishing', async () => {
    const userId = rememberUser(createUser())
    const { origin } = await serveRoutes()

    const markdown = createSite({
      userId,
      files: [{ path: 'index.md', data: Buffer.from('# original') }],
      entryRelative: 'index.md',
    })
    expect((await attachSite(origin, userId, markdown.slug)).status).toBe(200)
    patchWorkspace(userId, 'index.md', '# patched')
    const markdownPublish = await putBuilder(origin, markdown.slug, {
      revision: getAiWorkspace(userId)!.revision,
    }, { cookie: session(userId) })
    expect(markdownPublish.status).toBe(200)
    const markdownResult = await markdownPublish.json()
    expect(markdownResult.entry_point.endsWith('/index.md')).toBe(true)
    expect(readFileSync(join(publishedDir(markdown.slug), 'index.md'), 'utf8')).toBe('# patched')

    const multi = createSite({
      userId,
      files: [
        { path: 'index.html', data: Buffer.from('<h1>default</h1>') },
        { path: 'home.html', data: Buffer.from('<h1>home</h1>') },
      ],
      entryRelative: 'home.html',
    })
    expect((await attachSite(origin, userId, multi.slug, getAiWorkspace(userId)!.revision)).status).toBe(200)
    patchWorkspace(userId, 'home.html', '<h1>home patched</h1>')
    const multiPublish = await putBuilder(origin, multi.slug, {
      revision: getAiWorkspace(userId)!.revision,
    }, { cookie: session(userId) })
    expect(multiPublish.status).toBe(200)
    const multiResult = await multiPublish.json()
    expect(multiResult.entry_point.endsWith('/home.html')).toBe(true)
    expect(readFileSync(join(publishedDir(multi.slug), 'home.html'), 'utf8')).toBe('<h1>home patched</h1>')
    expect(readFileSync(join(publishedDir(multi.slug), 'index.html'), 'utf8')).toBe('<h1>default</h1>')
  })

  it('returns 409 when the live site changed since attach', async () => {
    const userId = rememberUser(createUser())
    const site = createSite({ userId })
    const { origin } = await serveRoutes()
    expect((await attachSite(origin, userId, site.slug)).status).toBe(200)

    const switched = new Database(getDbPath())
    try {
      switched
        .prepare("UPDATE uploads SET entry_point = ? WHERE slug = ? AND id = ?")
        .run('elsewhere/index.html', site.slug, site.id)
    } finally {
      switched.close()
    }

    const response = await putBuilder(origin, site.slug, {
      revision: getAiWorkspace(userId)!.revision,
    }, { cookie: session(userId) })

    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe('workspace_conflict')
    expect(findUploadBySlug(site.slug)!.entry_point).toBe('elsewhere/index.html')
  })

  it('rejects management fields, an API token alone, a stale revision, and an unattached slug', async () => {
    const userId = rememberUser(createUser())
    const site = createSite({ userId })
    const other = createSite({ userId })
    const { origin } = await serveRoutes()
    expect((await attachSite(origin, userId, site.slug)).status).toBe(200)
    const revision = getAiWorkspace(userId)!.revision

    const withFile = await putBuilder(origin, site.slug, {
      revision,
      extra: [['file', 'x']],
    }, { cookie: session(userId) })
    const apiOnly = await putBuilder(origin, site.slug, { revision }, { authorization: 'Bearer token' })
    const stale = await putBuilder(origin, site.slug, { revision: revision + 3 }, { cookie: session(userId) })
    const otherSlug = await putBuilder(origin, other.slug, { revision }, { cookie: session(userId) })

    expect(withFile.status).toBe(400)
    expect(apiOnly.status).toBe(401)
    expect(stale.status).toBe(409)
    expect(otherSlug.status).toBe(409)
    expect(findUploadBySlug(site.slug)!.entry_point).toBe(site.entryPoint)
  })

  it('returns 503 when unavailable and 404 when the attached site is deleted', async () => {
    const userId = rememberUser(createUser())
    const site = createSite({ userId })
    const { origin } = await serveRoutes()
    expect((await attachSite(origin, userId, site.slug)).status).toBe(200)
    const revision = getAiWorkspace(userId)!.revision

    vi.stubEnv('JOLT_AI_API_KEY', '')
    const unavailable = await putBuilder(origin, site.slug, { revision }, { cookie: session(userId) })
    vi.stubEnv('JOLT_AI_API_KEY', TEST_KEY)

    deleteUploadBySlug(site.slug)
    const gone = await putBuilder(origin, site.slug, { revision }, { cookie: session(userId) })

    expect(unavailable.status).toBe(503)
    expect(gone.status).toBe(404)
    expect((await gone.json()).error.code).toBe('target_unavailable')
  })
})

describe('POST /api/ai/restore', () => {
  it('restores the attach snapshot locally and leaves the live site until an explicit publish', async () => {
    const userId = rememberUser(createUser())
    const site = createSite({ userId })
    const { origin } = await serveRoutes()
    expect((await attachSite(origin, userId, site.slug)).status).toBe(200)
    patchWorkspace(userId, 'index.html', '<h1>patched</h1>')

    const published = await putBuilder(origin, site.slug, {
      revision: getAiWorkspace(userId)!.revision,
    }, { cookie: session(userId) })
    expect(published.status).toBe(200)
    const patchedDir = publishedDir(site.slug)
    expect(readFileSync(join(patchedDir, 'index.html'), 'utf8')).toBe('<h1>patched</h1>')

    const workspace = getAiWorkspace(userId)!
    const restore = await postJson(origin, '/api/ai/restore', { revision: workspace.revision }, { cookie: session(userId) })

    expect(restore.status).toBe(200)
    const state = await restore.json()
    expect(state.revision).toBe(workspace.revision + 1)
    const restoredFile = readWorkspaceFile(userId, getAiWorkspace(userId)!.current_generation, 'index.html')
    expect(restoredFile.content).toBe('<h1>original</h1>')
    // The hosted site is untouched by a local restore.
    expect(readFileSync(join(patchedDir, 'index.html'), 'utf8')).toBe('<h1>patched</h1>')

    const republished = await putBuilder(origin, site.slug, {
      revision: getAiWorkspace(userId)!.revision,
    }, { cookie: session(userId) })
    expect(republished.status).toBe(200)
    const restoredDir = publishedDir(site.slug)
    expect(readFileSync(join(restoredDir, 'index.html'), 'utf8')).toBe('<h1>original</h1>')
    expect(readFileSync(join(restoredDir, 'img/logo.png'))).toEqual(LOGO)
  })

  it('returns 409 without a snapshot, 404 for a deleted target, and 403 after reownership', async () => {
    const userId = rememberUser(createUser())
    const other = rememberUser(createUser())
    const { origin } = await serveRoutes()

    const alpha = createSite({ userId })
    expect((await attachSite(origin, userId, alpha.slug)).status).toBe(200)
    deleteUploadBySlug(alpha.slug)
    const deleted = await postJson(
      origin,
      '/api/ai/restore',
      { revision: getAiWorkspace(userId)!.revision },
      { cookie: session(userId) }
    )

    const beta = createSite({ userId })
    expect((await attachSite(origin, userId, beta.slug, getAiWorkspace(userId)!.revision)).status).toBe(200)
    const reown = new Database(getDbPath())
    try {
      reown.prepare('UPDATE uploads SET user_id = ? WHERE slug = ? AND id = ?').run(other, beta.slug, beta.id)
    } finally {
      reown.close()
    }
    const foreign = await postJson(
      origin,
      '/api/ai/restore',
      { revision: getAiWorkspace(userId)!.revision },
      { cookie: session(userId) }
    )

    const detached = rememberUser(createUser())
    const noSnapshot = await postJson(origin, '/api/ai/restore', { revision: 0 }, { cookie: session(detached) })

    expect(deleted.status).toBe(404)
    expect(foreign.status).toBe(403)
    expect((await foreign.json()).error.code).toBe('target_forbidden')
    expect(noSnapshot.status).toBe(409)
    expect((await noSnapshot.json()).error.code).toBe('no_edit_snapshot')
  })
})

describe('POST /api/ai/reset', () => {
  it('returns to new mode, clears the attachment and snapshot, and works after expiry', async () => {
    const userId = rememberUser(createUser())
    const site = createSite({ userId })
    const { origin } = await serveRoutes()
    expect((await attachSite(origin, userId, site.slug)).status).toBe(200)
    const attached = getAiWorkspace(userId)!
    const snapshotDir = attached.snapshot_dir!

    updateExpirationBySlug(site.slug, '2000-01-01T00:00:00.000Z')
    const response = await postJson(origin, '/api/ai/reset', { revision: attached.revision }, { cookie: session(userId) })

    expect(response.status).toBe(200)
    const state = await response.json()
    expect(state.revision).toBe(attached.revision + 1)
    expect(state.files).toEqual([])
    expect(state.target).toBeNull()
    expect(state.restore_available).toBe(false)

    const reset = getAiWorkspace(userId)!
    expect(reset.attached_slug).toBeNull()
    expect(reset.snapshot_dir).toBeNull()
    expect(reset.session_id).not.toBe(attached.session_id)
    expect(existsSync(join(getWorkspaceDir(userId), snapshotDir))).toBe(false)
    const generationsDir = join(getWorkspaceDir(userId), '.generations')
    expect(existsSync(generationsDir) ? readdirSync(generationsDir).length : 0).toBe(0)
  })

  it('is a no-op empty state for a user without a workspace and rejects a stale revision', async () => {
    const userId = rememberUser(createUser())
    const site = createSite({ userId })
    const { origin } = await serveRoutes()

    const empty = await postJson(origin, '/api/ai/reset', { revision: 0 }, { cookie: session(userId) })
    expect(empty.status).toBe(200)
    expect((await empty.json()).revision).toBe(0)

    expect((await attachSite(origin, userId, site.slug)).status).toBe(200)
    const stale = await postJson(origin, '/api/ai/reset', { revision: 99 }, { cookie: session(userId) })
    expect(stale.status).toBe(409)
  })
})

describe('upload list builder eligibility', () => {
  it('marks only nonanonymous, unexpired rows as ai_editable', async () => {
    const userId = rememberUser(createUser())
    const owned = createSite({ userId })
    const anonymous = createSite({ userId: null })
    const expired = createSite({ userId, expiresAt: '2000-01-01T00:00:00.000Z' })
    const { origin } = await serveRoutes()

    const mine = await fetch(`${origin}/api/user/uploads?limit=100`, { headers: { cookie: session(userId) } })
    const mineItems = (await mine.json()).items as { slug: string; ai_editable: boolean }[]

    // The user list is already scoped to the account, so eligibility is expiry only.
    expect(mineItems.find((item) => item.slug === owned.slug)?.ai_editable).toBe(true)
    expect(mineItems.find((item) => item.slug === expired.slug)?.ai_editable).toBe(false)
    expect(mineItems.find((item) => item.slug === anonymous.slug)).toBeUndefined()

    const admin = await fetch(`${origin}/api/admin/uploads?limit=100`, { headers: { cookie: adminSession() } })
    const adminItems = (await admin.json()).items as { slug: string; ai_editable: boolean }[]
    expect(adminItems.find((item) => item.slug === owned.slug)?.ai_editable).toBe(true)
    expect(adminItems.find((item) => item.slug === expired.slug)?.ai_editable).toBe(false)
    expect(adminItems.find((item) => item.slug === anonymous.slug)?.ai_editable).toBe(false)
    expect(adminItems.every((item) => !('user_id' in item))).toBe(true)
  })
})
