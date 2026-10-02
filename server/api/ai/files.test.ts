import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRouter, type EventHandler } from 'h3'
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
  deleteUser,
  finalizeAiTurnError,
  finalizeAiTurnSuccess,
  getAiWorkspace,
  getOrCreateAiWorkspace,
  insertAiTurnPending,
} from '~/server/utils/db'
import { commitPreparedGeneration, writeWorkspaceGeneration } from '~/server/utils/ai-workspace'

// The route files rely on Nuxt's auto-imported global, and it must be stubbed
// before the route module is evaluated — which is why routes are loaded with a
// dynamic import inside each test rather than a hoisted static import.
vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)

const session = (userId: string) => `jolt_user=${userCookieValue(userId)}`

/** Serves both file routes through a real h3 router so `[...path]` params resolve. */
async function serveFiles() {
  vi.stubEnv('JOLT_AI_API_KEY', TEST_KEY)
  vi.stubEnv('JOLT_AI_BASE_URL', 'http://127.0.0.1:1/v1')
  vi.stubEnv('JOLT_AI_MODEL', REQUESTED_MODEL)
  const listHandler = (await import('./files.get')).default as EventHandler
  const fileHandler = (await import('./files/[...path].get')).default as EventHandler
  const router = createRouter()
  router.get('/api/ai/files', listHandler)
  router.get('/api/ai/files/**:path', fileHandler)
  return startApp(router.handler)
}

function seedWorkspace(userId: string, entries: { path: string; data: Buffer }[], entryFile: string) {
  const workspace = getOrCreateAiWorkspace(userId)!
  const prepared = writeWorkspaceGeneration(userId, entries, entryFile)
  expect(commitPreparedGeneration(userId, prepared, workspace.revision, workspace.current_generation)).toBe(true)
  return prepared
}

function seedTurn(userId: string, sessionId: string, userContent: string, assistantContent: string) {
  const turnId = randomUUID()
  insertAiTurnPending({ turnId, userId, sessionId, userContent })
  finalizeAiTurnSuccess({
    turnId,
    userId,
    summary: assistantContent,
    model: 'seed-model',
    inputTokens: 3,
    outputTokens: 4,
    durationMs: 5,
  })
}

async function getState(origin: string, userId: string) {
  const response = await fetch(`${origin}/api/ai/files`, { headers: { cookie: session(userId) } })
  return { response, body: await response.json() }
}

async function getFile(origin: string, userId: string, path: string) {
  const response = await fetch(`${origin}/api/ai/files/${path}`, { headers: { cookie: session(userId) } })
  return { response, body: await response.json() }
}

beforeEach(() => {
  vi.stubEnv('JOLT_APP_ORIGIN', APP_ORIGIN)
  vi.stubEnv('JOLT_SITE_BASE_ORIGIN', SITE_ORIGIN)
  vi.stubEnv('ENABLE_AI_BUILDER', 'true')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeHarness()
})

describe('GET /api/ai/files', () => {
  it('returns 503 without a key and allocates nothing', async () => {
    const userId = createUser()
    const origin = await serveFiles()
    vi.stubEnv('JOLT_AI_API_KEY', '')

    const { response, body } = await getState(origin, userId)

    expect(response.status).toBe(503)
    expect(body).toEqual({ error: { code: 'ai_unavailable', message: 'AI Builder is not available on this server.' } })
    expect(getAiWorkspace(userId)).toBeNull()
  })

  it('requires a registered-account session', async () => {
    const origin = await serveFiles()
    const deletedUser = createUser()
    deleteUser(deletedUser)

    const anonymous = await fetch(`${origin}/api/ai/files`)
    const deleted = await fetch(`${origin}/api/ai/files`, { headers: { cookie: session(deletedUser) } })

    expect(anonymous.status).toBe(401)
    expect((await anonymous.json()).error.code).toBe('authentication_required')
    expect(deleted.status).toBe(401)
    expect(getAiWorkspace(deletedUser)).toBeNull()
  })

  it('returns an empty state without creating a workspace or chat records', async () => {
    const userId = createUser()
    const origin = await serveFiles()

    const { response, body } = await getState(origin, userId)

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(body).toEqual({
      revision: 0,
      entry_file: 'index.html',
      files: [],
      editable_files: 0,
      editable_bytes: 0,
      opaque_files: 0,
      opaque_bytes: 0,
      target: null,
      restore_available: false,
      messages: [],
    })
    expect(getAiWorkspace(userId)).toBeNull()
  })

  it('lists committed editable and opaque files with counts and transcript rows', async () => {
    const userId = createUser()
    const workspace = getOrCreateAiWorkspace(userId)!
    seedWorkspace(
      userId,
      [
        { path: 'index.html', data: Buffer.from('<h1>hi</h1>') },
        { path: 'styles/site.css', data: Buffer.from('body{}') },
        { path: 'images/logo.png', data: Buffer.from([0x89, 0x50, 0x00, 0x01]) },
      ],
      'index.html'
    )
    seedTurn(userId, workspace.session_id, 'build it', 'Built it.')
    const failedTurn = randomUUID()
    insertAiTurnPending({ turnId: failedTurn, userId, sessionId: workspace.session_id, userContent: 'broken' })
    finalizeAiTurnError({
      turnId: failedTurn,
      userId,
      summary: 'The model response was not usable.',
      errorCode: 'invalid_model_output',
      model: null,
      inputTokens: null,
      outputTokens: null,
      durationMs: 7,
    })

    const base = await serveFiles()
    const { response, body } = await getState(base, userId)

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      revision: 1,
      entry_file: 'index.html',
      files: [
        { path: 'images/logo.png', bytes: 4, editable: false },
        { path: 'index.html', bytes: 11, editable: true },
        { path: 'styles/site.css', bytes: 6, editable: true },
      ],
      editable_files: 2,
      editable_bytes: 17,
      opaque_files: 1,
      opaque_bytes: 4,
      target: null,
      restore_available: false,
    })
    expect(body.messages).toHaveLength(4)
    for (const message of body.messages) {
      expect(Object.keys(message).sort()).toEqual(['content', 'created_at', 'id', 'role', 'status', 'turn_id'])
    }
    // Pending and error rows are returned for honest UI state; raw manifests are
    // not. Rows written in the same second tie on (created_at, id), so only the
    // set is deterministic here.
    expect(body.messages.map((message: { status: string }) => message.status).sort()).toEqual([
      'error',
      'error',
      'ok',
      'ok',
    ])
    expect(body.messages.map((message: { role: string }) => message.role).sort()).toEqual([
      'assistant',
      'assistant',
      'user',
      'user',
    ])
    expect(body.messages.some((message: { content: string }) => message.content.includes('"files"'))).toBe(false)
  })

  it('returns only the newest twenty rows of the current session', async () => {
    const userId = createUser()
    const workspace = getOrCreateAiWorkspace(userId)!
    for (let index = 0; index < 25; index += 1) {
      seedTurn(userId, workspace.session_id, `message ${index}`, `summary ${index}`)
    }
    const otherSession = randomUUID()
    const otherTurn = randomUUID()
    insertAiTurnPending({ turnId: otherTurn, userId, sessionId: otherSession, userContent: 'other session' })
    finalizeAiTurnSuccess({
      turnId: otherTurn,
      userId,
      summary: 'other',
      model: null,
      inputTokens: null,
      outputTokens: null,
      durationMs: null,
    })

    const { body } = await getState(await serveFiles(), userId)

    expect(body.messages).toHaveLength(20)
    expect(body.messages.every((message: { turn_id: string }) => message.turn_id !== otherTurn)).toBe(true)
  })
})

describe('GET /api/ai/files/[...path]', () => {
  it('returns one editable file as JSON text with its committed revision', async () => {
    const userId = createUser()
    const origin = await serveFiles()
    seedWorkspace(
      userId,
      [
        { path: 'index.html', data: Buffer.from('<h1 onclick="alert(1)">hi</h1>') },
        { path: 'styles/site.css', data: Buffer.from('body { color: red }') },
      ],
      'index.html'
    )

    const { response, body } = await getFile(origin, userId, 'index.html')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(body).toEqual({
      path: 'index.html',
      content: '<h1 onclick="alert(1)">hi</h1>',
      bytes: 30,
      revision: 1,
    })
  })

  it('decodes the wildcard path exactly once', async () => {
    const userId = createUser()
    const origin = await serveFiles()
    seedWorkspace(
      userId,
      [
        { path: 'index.html', data: Buffer.from('<h1>hi</h1>') },
        { path: 'styles/site.css', data: Buffer.from('body{}') },
      ],
      'index.html'
    )

    const encoded = await getFile(origin, userId, 'styles%2Fsite.css')
    expect(encoded.response.status).toBe(200)
    expect(encoded.body).toEqual({ path: 'styles/site.css', content: 'body{}', bytes: 6, revision: 1 })

    const traversal = await getFile(origin, userId, '%2e%2e%2fsecret')
    expect(traversal.response.status).toBe(400)
    expect(traversal.body.error.code).toBe('invalid_path')

    const malformed = await getFile(origin, userId, '%zz')
    expect(malformed.response.status).toBe(400)
    expect(malformed.body.error.code).toBe('invalid_path')
  })

  it('returns 404 for an absent file and 403 for an opaque one', async () => {
    const userId = createUser()
    const origin = await serveFiles()
    seedWorkspace(
      userId,
      [
        { path: 'index.html', data: Buffer.from('<h1>hi</h1>') },
        { path: 'images/logo.png', data: Buffer.from([0x89, 0x50, 0x00, 0x01]) },
        { path: 'assets/notes.txt', data: Buffer.from([0x01, 0x00, 0x02]) },
      ],
      'index.html'
    )

    const missing = await getFile(origin, userId, 'nope.html')
    expect(missing.response.status).toBe(404)
    expect(missing.body.error.code).toBe('file_not_found')

    const notImage = await getFile(origin, userId, 'images/logo.png')
    expect(notImage.response.status).toBe(403)
    expect(notImage.body.error.code).toBe('opaque_file')

    // A binary payload with an editable-looking extension stays opaque.
    const notText = await getFile(origin, userId, 'assets/notes.txt')
    expect(notText.response.status).toBe(403)
    expect(notText.body.error.code).toBe('opaque_file')
  })

  it('never exposes another account workspace', async () => {
    const owner = createUser()
    const stranger = createUser()
    const origin = await serveFiles()
    seedWorkspace(stranger, [{ path: 'index.html', data: Buffer.from('<h1>theirs</h1>') }], 'index.html')

    const own = await getFile(origin, stranger, 'index.html')
    expect(own.response.status).toBe(200)

    const foreign = await getFile(origin, owner, 'index.html')
    expect(foreign.response.status).toBe(404)
    expect(foreign.body.error.code).toBe('file_not_found')
  })

  it('requires an available builder and a session, and answers 404 with no workspace', async () => {
    const userId = createUser()
    const origin = await serveFiles()

    const noWorkspace = await getFile(origin, userId, 'index.html')
    expect(noWorkspace.response.status).toBe(404)

    const anonymous = await fetch(`${origin}/api/ai/files/index.html`)
    expect(anonymous.status).toBe(401)

    vi.stubEnv('ENABLE_AI_BUILDER', 'false')
    const unavailable = await getFile(origin, userId, 'index.html')
    expect(unavailable.response.status).toBe(503)
    expect(unavailable.body.error.code).toBe('ai_unavailable')
  })
})
