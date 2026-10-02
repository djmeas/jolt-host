import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventHandler } from 'h3'
import {
  APP_ORIGIN,
  SITE_ORIGIN,
  TEST_KEY,
  REQUESTED_MODEL,
  closeHarness,
  createUser,
  startApp,
  userCookieValue,
} from '../../../test/helpers/ai-endpoints'
import {
  compareAndSwitchAiWorkspace,
  deleteUploadBySlug,
  deleteUser,
  getAiWorkspace,
  getAllUploadIds,
  getOrCreateAiWorkspace,
  getStorageDir,
  getUploadsByUserId,
  updateUserLimits,
} from '~/server/utils/db'
import { commitPreparedGeneration, writeWorkspaceGeneration } from '~/server/utils/ai-workspace'
import { resetAiOperations, tryAcquireAiOperation } from '~/server/utils/ai-rate-limit'
import { resetRateLimitStore } from '~/server/utils/rate-limit'

// Nuxt auto-imported globals the route and the shared creation helper rely on.
// They must exist before the route module is evaluated, hence the dynamic import.
vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
vi.stubGlobal('useRuntimeConfig', () => ({
  jolthost: { uploadMaxBytes: 25 * 1024 * 1024 },
  turnstileSecretKey: '',
}))

const loadPreviewHandler = () => import('./preview.post').then((module) => module.default as EventHandler)

/** The full `Cookie` header carrying one signed registered-user session. */
const session = (userId: string) => `jolt_user=${userCookieValue(userId)}`

const createdSlugs: string[] = []

function rememberUpload(slug: string): void {
  createdSlugs.push(slug)
}

/** Removes upload rows and their storage directories created by a test. */
function cleanupUploads(): void {
  for (const slug of createdSlugs.splice(0)) {
    try {
      deleteUploadBySlug(slug)
    } catch {
      // Best effort when a test already removed the row.
    }
    try {
      rmSync(join(getStorageDir(), slug), { recursive: true, force: true })
    } catch {
      // Best effort filesystem cleanup of the shared test storage directory.
    }
  }
}

/** Loads the route module and serves it over a real loopback HTTP server. */
async function servePreview() {
  const origin = await startApp(await loadPreviewHandler())
  return { origin }
}

type PreviewOptions = {
  cookie?: string | null
  origin?: string | null
  contentType?: string | null
}

async function postPreview(serverOrigin: string, body: unknown, options: PreviewOptions = {}) {
  const headers: Record<string, string> = {}
  const contentType = options.contentType === undefined ? 'application/json' : options.contentType
  if (contentType !== null) headers['content-type'] = contentType
  const requestOrigin = options.origin === undefined ? APP_ORIGIN : options.origin
  if (requestOrigin !== null) headers.origin = requestOrigin
  if (options.cookie) headers.cookie = options.cookie
  return fetch(`${serverOrigin}/api/ai/preview`, { method: 'POST', headers, body: JSON.stringify(body) })
}

function seedWorkspace(
  userId: string,
  entries: { path: string; data: Buffer }[],
  entryFile: string
): void {
  const workspace = getOrCreateAiWorkspace(userId)!
  const prepared = writeWorkspaceGeneration(userId, entries, entryFile)
  expect(commitPreparedGeneration(userId, prepared, workspace.revision, workspace.current_generation)).toBe(true)
}

function landingWorkspace(): { path: string; data: Buffer }[] {
  return [
    { path: 'index.html', data: Buffer.from('<!doctype html><h1>Hello</h1>') },
    { path: 'styles/site.css', data: Buffer.from('body { color: red }') },
  ]
}

function workspaceState(userId: string) {
  const row = getAiWorkspace(userId)!
  return { revision: row.revision, generation: row.current_generation, attached: row.attached_upload_id }
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

describe('POST /api/ai/preview availability and request guards', () => {
  it('returns 503 without a key and never allocates a workspace or upload', async () => {
    const userId = createUser()
    vi.stubEnv('JOLT_AI_API_KEY', '')
    const { origin } = await servePreview()
    const uploadsBefore = getAllUploadIds().length

    const response = await postPreview(origin, { revision: 0 }, { cookie: session(userId) })

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: { code: 'ai_unavailable', message: 'AI Builder is not available on this server.' },
    })
    expect(getAiWorkspace(userId)).toBeNull()
    expect(getAllUploadIds().length).toBe(uploadsBefore)
  })

  it('rejects anonymous sessions, deleted accounts, and admin-only cookies', async () => {
    const { origin } = await servePreview()
    const deletedUser = createUser()
    deleteUser(deletedUser)
    const uploadsBefore = getAllUploadIds().length

    const anonymous = await postPreview(origin, { revision: 0 })
    const adminOnly = await postPreview(origin, { revision: 0 }, { cookie: 'jolt_admin=whatever' })
    const deleted = await postPreview(origin, { revision: 0 }, { cookie: session(deletedUser) })

    for (const response of [anonymous, adminOnly, deleted]) {
      expect(response.status).toBe(401)
      expect((await response.json()).error.code).toBe('authentication_required')
    }
    expect(getAllUploadIds().length).toBe(uploadsBefore)
  })

  it('rejects a mutation from another origin', async () => {
    const userId = createUser()
    const { origin } = await servePreview()

    const response = await postPreview(origin, { revision: 0 }, { cookie: session(userId), origin: 'http://evil.test' })

    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe('origin_mismatch')
    expect(getAiWorkspace(userId)).toBeNull()
  })

  it('requires a JSON content type and rejects unknown fields and bad types', async () => {
    const userId = createUser()
    const { origin } = await servePreview()
    const cookie = session(userId)

    const wrongType = await postPreview(origin, { revision: 0 }, { cookie, contentType: 'text/plain' })
    const unknownField = await postPreview(origin, { revision: 0, user_id: 'someone-else' }, { cookie })
    const badRevision = await postPreview(origin, { revision: -1 }, { cookie })
    const badEnableData = await postPreview(origin, { revision: 0, enable_data: 'true' }, { cookie })

    expect(wrongType.status).toBe(400)
    expect(unknownField.status).toBe(400)
    expect((await unknownField.json()).error.code).toBe('invalid_request')
    expect(badRevision.status).toBe(400)
    expect(badEnableData.status).toBe(400)
  })

  it('returns 409 workspace_busy while another operation holds the account', async () => {
    const userId = createUser()
    seedWorkspace(userId, landingWorkspace(), 'index.html')
    const { origin } = await servePreview()
    expect(tryAcquireAiOperation(userId)).toBe(true)

    const response = await postPreview(origin, { revision: 1 }, { cookie: session(userId) })

    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe('workspace_busy')
  })

  it('returns 409 empty_workspace for a workspace with no committed files', async () => {
    const userId = createUser()
    getOrCreateAiWorkspace(userId)
    const { origin } = await servePreview()
    const uploadsBefore = getAllUploadIds().length

    const response = await postPreview(origin, { revision: 0 }, { cookie: session(userId) })

    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe('empty_workspace')
    expect(getAllUploadIds().length).toBe(uploadsBefore)
  })

  it('returns 409 workspace_conflict for a stale revision', async () => {
    const userId = createUser()
    seedWorkspace(userId, landingWorkspace(), 'index.html')
    const { origin } = await servePreview()

    const response = await postPreview(origin, { revision: 0 }, { cookie: session(userId) })

    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe('workspace_conflict')
  })

  it('returns 409 attached_workspace and never publishes an attached draft', async () => {
    const userId = createUser()
    seedWorkspace(userId, landingWorkspace(), 'index.html')
    const row = getAiWorkspace(userId)!
    expect(
      compareAndSwitchAiWorkspace({
        userId,
        expectedRevision: row.revision,
        expectedGeneration: row.current_generation,
        generation: row.current_generation,
        entryFile: row.entry_file,
        attachment: {
          uploadId: randomUUID(),
          slug: 'attached-site',
          entryPoint: 'attached-site/index.html',
          snapshotDir: '.pre-edit-1000000000',
        },
      })
    ).toBe(true)
    const { origin } = await servePreview()
    const revision = getAiWorkspace(userId)!.revision
    const uploadsBefore = getAllUploadIds().length

    const response = await postPreview(origin, { revision }, { cookie: session(userId) })

    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe('attached_workspace')
    expect(getAllUploadIds().length).toBe(uploadsBefore)
  })
})

describe('POST /api/ai/preview publication', () => {
  it('publishes the exact workspace text as a new owned upload and leaves the workspace intact', async () => {
    const userId = createUser()
    seedWorkspace(userId, landingWorkspace(), 'index.html')
    const before = workspaceState(userId)
    const { origin } = await servePreview()

    const response = await postPreview(
      origin,
      { revision: before.revision, title: 'My site', expiration: '1h', password: 'secret', enable_data: false },
      { cookie: session(userId) }
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const result: Record<string, string> = await response.json()
    rememberUpload(result.slug)

    expect(result.url).toBe(`http://${result.slug}.sites.test/`)
    expect(result.entry_point).toBe(`${result.slug}/index.html`)
    expect(result.owner_token).toEqual(expect.any(String))
    expect(result.title).toBe('My site')
    expect(result.expires_at).not.toBe('')
    expect(result.url_with_unlock).toContain(`http://${result.slug}.sites.test/?unlock=`)
    expect(result.data_enabled).toBeUndefined()

    // Exactly the generated text is extracted; no metadata, snapshot, or
    // generation directory can leak into the published site.
    const uploadDir = join(getStorageDir(), result.slug)
    expect(readdirSync(uploadDir).sort()).toEqual(['index.html', 'styles'])
    expect(readFileSync(join(uploadDir, 'index.html'), 'utf8')).toBe('<!doctype html><h1>Hello</h1>')
    expect(readFileSync(join(uploadDir, 'styles', 'site.css'), 'utf8')).toBe('body { color: red }')

    // Publication is attributed to the signed-in account and does not mutate the
    // private workspace.
    expect(getUploadsByUserId(userId, 1, 100).items.map((item) => item.slug)).toContain(result.slug)
    expect(workspaceState(userId)).toEqual(before)
  })

  it('defaults to a one-hour expiration and no password', async () => {
    const userId = createUser()
    seedWorkspace(userId, landingWorkspace(), 'index.html')
    const { origin } = await servePreview()

    const response = await postPreview(origin, { revision: 1 }, { cookie: session(userId) })

    expect(response.status).toBe(200)
    const result: Record<string, string> = await response.json()
    rememberUpload(result.slug)
    expect(result.title).toBe('')
    expect(result.expires_at).not.toBe('')
    expect(result.url_with_unlock).toBeUndefined()
  })

  it('returns 413 for the account size limit without creating an upload', async () => {
    const userId = createUser()
    seedWorkspace(userId, landingWorkspace(), 'index.html')
    updateUserLimits(userId, 16, 0)
    const { origin } = await servePreview()
    const uploadsBefore = getAllUploadIds().length

    const response = await postPreview(origin, { revision: 1 }, { cookie: session(userId) })

    expect(response.status).toBe(413)
    expect((await response.json()).error.code).toBe('request_too_large')
    expect(getAllUploadIds().length).toBe(uploadsBefore)
  })

  it('maps a disabled data opt-in to 403 data_toggle_disabled', async () => {
    const userId = createUser()
    seedWorkspace(userId, landingWorkspace(), 'index.html')
    const { origin } = await servePreview()
    vi.stubEnv('ENABLE_DATA_API_TOGGLE', 'false')
    const uploadsBefore = getAllUploadIds().length

    const response = await postPreview(
      origin,
      { revision: 1, enable_data: true, password: 'secret' },
      { cookie: session(userId) }
    )

    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe('data_toggle_disabled')
    expect(getAllUploadIds().length).toBe(uploadsBefore)
  })

  it('returns creation-policy errors for a bad expiration and a data opt-in without a password', async () => {
    const userId = createUser()
    seedWorkspace(userId, landingWorkspace(), 'index.html')
    const { origin } = await servePreview()
    const cookie = session(userId)
    const uploadsBefore = getAllUploadIds().length

    const badExpiration = await postPreview(origin, { revision: 1, expiration: 'nope' }, { cookie })
    const dataWithoutPassword = await postPreview(origin, { revision: 1, enable_data: true }, { cookie })

    expect(badExpiration.status).toBe(400)
    expect((await badExpiration.json()).error.code).toBe('invalid_request')
    expect(dataWithoutPassword.status).toBe(400)
    expect(getAllUploadIds().length).toBe(uploadsBefore)
  })
})
