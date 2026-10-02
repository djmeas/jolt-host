import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventHandler } from 'h3'
import {
  APP_ORIGIN,
  SITE_ORIGIN,
  REQUESTED_MODEL,
  TEST_KEY,
  closeHarness,
  createUser,
  manifestEnvelope,
  respondWithJson,
  startApp,
  startProvider,
  userCookieValue,
  type CapturedRequest,
  type ProviderResponder,
} from '../../../test/helpers/ai-endpoints'
import {
  deleteUser,
  finalizeAiTurnSuccess,
  getAiMessages,
  getAiWorkspace,
  getOrCreateAiWorkspace,
  insertAiTurnPending,
} from '~/server/utils/db'
import { updateUserAiBuild } from '~/server/utils/db'
import {
  commitPreparedGeneration,
  describeWorkspace,
  getWorkspaceDir,
  writeWorkspaceGeneration,
} from '~/server/utils/ai-workspace'
import { AI_SYSTEM_PROMPT, type AiChatMessage } from '~/server/utils/ai-builder'
import {
  AI_CHAT_RATE_MAX,
  checkAiChatRateLimit,
  isAiOperationActive,
  resetAiOperations,
  resetAiRateLimits,
} from '~/server/utils/ai-rate-limit'

// The route files rely on Nuxt's auto-imported global, and it must be stubbed
// before the route module is evaluated — which is why routes are loaded with a
// dynamic import inside each test rather than a hoisted static import.
vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)

const LANDING_MANIFEST = {
  summary: 'Created a landing page and stylesheet.',
  files: [
    { op: 'add', path: 'index.html', content: '<!doctype html><h1>Hello</h1>' },
    { op: 'add', path: 'styles/site.css', content: 'body { color: red }' },
  ],
}

const loadChatHandler = () => import('./chat.post').then((module) => module.default as EventHandler)

/** The full `Cookie` header carrying one signed registered-user session. */
const session = (userId: string) => `jolt_user=${userCookieValue(userId)}`

function sendManifest(manifest: unknown, overrides: Record<string, unknown> = {}): ProviderResponder {
  return respondWithJson(manifestEnvelope(manifest, overrides))
}

/** Loads the route module and serves it over a real loopback HTTP server. */
async function serveChat(respond: ProviderResponder) {
  const provider = await startProvider(respond)
  vi.stubEnv('JOLT_AI_API_KEY', TEST_KEY)
  vi.stubEnv('JOLT_AI_BASE_URL', provider.baseUrl)
  vi.stubEnv('JOLT_AI_MODEL', REQUESTED_MODEL)
  const origin = await startApp(await loadChatHandler())
  return { provider, origin }
}

type ChatOptions = {
  cookie?: string | null
  origin?: string | null
  contentType?: string | null
  body?: BodyInit
}

async function postChat(serverOrigin: string, body: unknown, options: ChatOptions = {}) {
  const headers: Record<string, string> = {}
  const contentType = options.contentType === undefined ? 'application/json' : options.contentType
  if (contentType !== null) headers['content-type'] = contentType
  const requestOrigin = options.origin === undefined ? APP_ORIGIN : options.origin
  if (requestOrigin !== null) headers.origin = requestOrigin
  if (options.cookie) headers.cookie = options.cookie
  const payload = options.body ?? JSON.stringify(body)
  return fetch(`${serverOrigin}/api/ai/chat`, {
    method: 'POST',
    headers,
    body: payload,
    ...(typeof payload === 'string' ? {} : { duplex: 'half' }),
  } as RequestInit)
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
    inputTokens: 1,
    outputTokens: 2,
    durationMs: 3,
  })
}

/** Revision, active generation, and the whole committed file set. */
function workspaceFingerprint(userId: string) {
  const row = getAiWorkspace(userId)
  const generation = row?.current_generation ?? null
  return { revision: row?.revision ?? 0, generation, files: describeWorkspace(userId, generation).files }
}

function generationNames(userId: string): string[] {
  const dir = join(getWorkspaceDir(userId), '.generations')
  return existsSync(dir) ? readdirSync(dir).sort() : []
}

/** The prompt the mock provider actually received. */
function sentRequest(request: CapturedRequest) {
  return request.json as {
    model: string
    max_tokens: number
    stream: boolean
    n: number
    messages: AiChatMessage[]
  }
}

function currentWorkspaceObject(messages: AiChatMessage[]): Record<string, unknown> {
  const delimited = messages.find((message) => message.content.startsWith('<current_workspace>'))!
  return JSON.parse(delimited.content.replace('<current_workspace>\n', '').replace('\n</current_workspace>', ''))
}

beforeEach(() => {
  vi.stubEnv('JOLT_APP_ORIGIN', APP_ORIGIN)
  vi.stubEnv('JOLT_SITE_BASE_ORIGIN', SITE_ORIGIN)
  vi.stubEnv('ENABLE_AI_BUILDER', 'true')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  resetAiRateLimits()
  resetAiOperations()
  await closeHarness()
})

describe('POST /api/ai/chat availability and authentication', () => {
  it('rejects a disabled account before calling the provider, then accepts it when enabled', async () => {
    const userId = createUser(false)
    const { provider, origin } = await serveChat(sendManifest(LANDING_MANIFEST))
    const rejected = await postChat(origin, { message: 'Build a page', revision: 0 }, { cookie: session(userId) })
    expect(rejected.status).toBe(403)
    expect((await rejected.json()).error.code).toBe('builder_disabled')
    expect(provider.requests).toHaveLength(0)
    expect(getAiWorkspace(userId)).toBeNull()
    updateUserAiBuild(userId, true)
    const accepted = await postChat(origin, { message: 'Build a page', revision: 0 }, { cookie: session(userId) })
    expect(accepted.status).toBe(200)
    expect(getAiWorkspace(userId)?.revision).toBe(1)
  })

  it('returns 503 without a key and never allocates a workspace or calls the provider', async () => {
    const userId = createUser()
    const provider = await startProvider(sendManifest(LANDING_MANIFEST))
    vi.stubEnv('JOLT_AI_API_KEY', '')
    vi.stubEnv('JOLT_AI_BASE_URL', provider.baseUrl)
    vi.stubEnv('JOLT_AI_MODEL', REQUESTED_MODEL)
    const origin = await startApp(await loadChatHandler())

    const response = await postChat(origin, { message: 'hello', revision: 0 }, { cookie: session(userId) })

    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      error: { code: 'ai_unavailable', message: 'AI Builder is not available on this server.' },
    })
    expect(provider.requests).toHaveLength(0)
    expect(getAiWorkspace(userId)).toBeNull()
  })

  it('returns 503 when the kill-switch is off', async () => {
    const userId = createUser()
    const { provider, origin } = await serveChat(sendManifest(LANDING_MANIFEST))
    vi.stubEnv('ENABLE_AI_BUILDER', 'false')

    const response = await postChat(origin, { message: 'hello', revision: 0 }, { cookie: session(userId) })

    expect(response.status).toBe(503)
    expect((await response.json()).error.code).toBe('ai_unavailable')
    expect(provider.requests).toHaveLength(0)
  })

  it('rejects anonymous sessions, deleted accounts, and admin-only cookies', async () => {
    const { provider, origin } = await serveChat(sendManifest(LANDING_MANIFEST))
    const deletedUser = createUser()
    deleteUser(deletedUser)

    const noCookie = await postChat(origin, { message: 'hi', revision: 0 })
    const deleted = await postChat(origin, { message: 'hi', revision: 0 }, { cookie: session(deletedUser) })
    const adminOnly = await postChat(origin, { message: 'hi', revision: 0 }, { cookie: 'jolt_admin=whatever' })

    for (const response of [noCookie, deleted, adminOnly]) {
      expect(response.status).toBe(401)
      expect((await response.json()).error.code).toBe('authentication_required')
    }
    expect(provider.requests).toHaveLength(0)
  })

  it('rejects mutations from another origin or with no origin proof', async () => {
    const userId = createUser()
    const { provider, origin } = await serveChat(sendManifest(LANDING_MANIFEST))
    const cookie = session(userId)

    const crossOrigin = await postChat(origin, { message: 'hi', revision: 0 }, { cookie, origin: 'http://evil.test' })
    const noOrigin = await postChat(origin, { message: 'hi', revision: 0 }, { cookie, origin: null })

    expect(crossOrigin.status).toBe(403)
    expect((await crossOrigin.json()).error.code).toBe('origin_mismatch')
    expect(noOrigin.status).toBe(403)
    expect(provider.requests).toHaveLength(0)
  })

  it('accepts a direct localhost app on another development port but rejects hosted site subdomains', async () => {
    const userId = createUser()
    const { provider, origin } = await serveChat(sendManifest(LANDING_MANIFEST))
    const cookie = session(userId)

    const hostedSite = await postChat(origin, { message: 'hi', revision: 0 }, {
      cookie,
      origin: 'http://untrusted.sites.localhost:49152',
    })
    const localApp = await postChat(origin, { message: 'hi', revision: 0 }, {
      cookie,
      origin: 'http://localhost:49152',
    })

    expect(hostedSite.status).toBe(403)
    expect((await hostedSite.json()).error.code).toBe('origin_mismatch')
    expect(localApp.status).toBe(200)
    expect(provider.requests).toHaveLength(1)
  })

  it('keeps the configured application origin exact in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const userId = createUser()
    const { provider, origin } = await serveChat(sendManifest(LANDING_MANIFEST))

    const response = await postChat(origin, { message: 'hi', revision: 0 }, {
      cookie: session(userId),
      origin: 'http://localhost:49152',
    })

    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe('origin_mismatch')
    expect(provider.requests).toHaveLength(0)
  })
})

describe('POST /api/ai/chat request bounds', () => {
  it('returns 413 for an over-limit declared body before the provider call', async () => {
    const userId = createUser()
    const { provider, origin } = await serveChat(sendManifest(LANDING_MANIFEST))

    const response = await postChat(
      origin,
      { message: 'x'.repeat(9000), revision: 0 },
      { cookie: session(userId) }
    )

    expect(response.status).toBe(413)
    expect((await response.json()).error.code).toBe('request_too_large')
    expect(provider.requests).toHaveLength(0)
  })

  it('returns 413 for a chunked body without a Content-Length', async () => {
    const userId = createUser()
    const { provider, origin } = await serveChat(sendManifest(LANDING_MANIFEST))
    const chunked = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ message: 'x'.repeat(9000), revision: 0 })))
        controller.close()
      },
    })

    const response = await postChat(origin, null, { cookie: session(userId), body: chunked })

    expect(response.status).toBe(413)
    expect(provider.requests).toHaveLength(0)
  })

  it('returns 400 for bad JSON, unknown fields, and invalid revisions', async () => {
    const userId = createUser()
    const { provider, origin } = await serveChat(sendManifest(LANDING_MANIFEST))
    const options = { cookie: session(userId) }

    const badJson = await postChat(origin, null, { ...options, body: '{not json' })
    const unknownField = await postChat(origin, { message: 'hi', revision: 0, user_id: 'someone-else' }, options)
    const noRevision = await postChat(origin, { message: 'hi' }, options)
    const negative = await postChat(origin, { message: 'hi', revision: -1 }, options)
    const fractional = await postChat(origin, { message: 'hi', revision: 1.5 }, options)
    const blank = await postChat(origin, { message: '   ', revision: 0 }, options)
    const wrongType = await postChat(origin, { message: 'hi', revision: '0' }, options)

    for (const response of [badJson, unknownField, noRevision, negative, fractional, blank, wrongType]) {
      expect(response.status).toBe(400)
      expect((await response.json()).error.code).toBe('invalid_request')
    }
    expect(provider.requests).toHaveLength(0)
  })

  it('requires a JSON content type', async () => {
    const userId = createUser()
    const { provider, origin } = await serveChat(sendManifest(LANDING_MANIFEST))

    const response = await postChat(
      origin,
      { message: 'hi', revision: 0 },
      { cookie: session(userId), contentType: 'text/plain' }
    )

    expect(response.status).toBe(400)
    expect(provider.requests).toHaveLength(0)
  })
})

describe('POST /api/ai/chat turns', () => {
  it('applies an initial manifest, records usage, and sends the documented prompt', async () => {
    const userId = createUser()
    const { provider, origin } = await serveChat(sendManifest(LANDING_MANIFEST))

    const response = await postChat(
      origin,
      { message: 'build me a landing page', revision: 0 },
      { cookie: session(userId) }
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-type')).toContain('application/json')
    const body = await response.json()
    expect(Object.keys(body).sort()).toEqual(['files', 'revision', 'summary', 'turn_id', 'usage', 'workspace_files'])
    expect(body).toMatchObject({
      summary: 'Created a landing page and stylesheet.',
      files: ['index.html', 'styles/site.css'],
      workspace_files: 2,
      revision: 1,
    })
    expect(body.usage).toMatchObject({ model: 'test-model-returned', input_tokens: 2400, output_tokens: 1100 })
    expect(Number.isSafeInteger(body.usage.duration_ms)).toBe(true)

    // The one provider call used the fixed request shape and the server prompt.
    expect(provider.requests).toHaveLength(1)
    const sent = sentRequest(provider.requests[0]!)
    expect(sent).toMatchObject({ model: REQUESTED_MODEL, max_tokens: 32768, stream: false, n: 1 })
    expect(provider.requests[0]!.headers.authorization).toBe(`Bearer ${TEST_KEY}`)
    expect(sent.messages).toHaveLength(3)
    expect(sent.messages[0]!.content).toBe(AI_SYSTEM_PROMPT)
    expect(sent.messages[2]).toEqual({ role: 'user', content: 'build me a landing page' })
    expect(currentWorkspaceObject(sent.messages)).toMatchObject({ entry_file: 'index.html', revision: 0, files: [] })

    // Committed generation and transcript agree with the response.
    const row = getAiWorkspace(userId)!
    expect(row.revision).toBe(1)
    expect(describeWorkspace(userId, row.current_generation).files).toEqual([
      { path: 'index.html', bytes: 29, editable: true },
      { path: 'styles/site.css', bytes: 19, editable: true },
    ])
    const messages = getAiMessages(userId, row.session_id)
    expect(messages.map((message) => message.status)).toEqual(['ok', 'ok'])
    const assistant = messages.find((message) => message.role === 'assistant')!
    expect(assistant).toMatchObject({
      content: 'Created a landing page and stylesheet.',
      model: 'test-model-returned',
      input_tokens: 2400,
      output_tokens: 1100,
    })
    expect(messages.find((message) => message.role === 'user')).toMatchObject({
      content: 'build me a landing page',
      model: null,
      input_tokens: null,
    })
  })

  it('applies follow-up add/update/delete to the exact final file set with current contents in the prompt', async () => {
    const userId = createUser()
    const workspace = getOrCreateAiWorkspace(userId)!
    seedWorkspace(
      userId,
      [
        { path: 'index.html', data: Buffer.from('<h1>old heading</h1>') },
        { path: 'styles/site.css', data: Buffer.from('body { color: red }') },
        { path: 'old-page.html', data: Buffer.from('<p>old</p>') },
      ],
      'index.html'
    )
    seedTurn(userId, workspace.session_id, 'make a site', 'Created three files.')

    const { provider, origin } = await serveChat(
      sendManifest({
        summary: 'Retitled the page and removed the old page.',
        files: [
          { op: 'update', path: 'index.html', content: '<h1>new heading</h1>' },
          { op: 'delete', path: 'old-page.html' },
          { op: 'add', path: 'scripts/app.js', content: 'console.log(1)' },
        ],
      })
    )

    const response = await postChat(origin, { message: 'retitle it', revision: 1 }, { cookie: session(userId) })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      summary: 'Retitled the page and removed the old page.',
      files: ['index.html', 'scripts/app.js', 'styles/site.css'],
      workspace_files: 3,
      revision: 2,
    })

    const row = getAiWorkspace(userId)!
    expect(describeWorkspace(userId, row.current_generation).files.map((file) => file.path)).toEqual([
      'index.html',
      'scripts/app.js',
      'styles/site.css',
    ])
    const deleted = join(getWorkspaceDir(userId), '.generations', row.current_generation!, 'content', 'old-page.html')
    expect(existsSync(deleted)).toBe(false)

    const sent = sentRequest(provider.requests[0]!)
    expect(currentWorkspaceObject(sent.messages)).toMatchObject({
      revision: 1,
      files: [
        { path: 'index.html', content: '<h1>old heading</h1>' },
        { path: 'old-page.html', content: '<p>old</p>' },
        { path: 'styles/site.css', content: 'body { color: red }' },
      ],
    })
    // History replays successful pairs, never a summary-selected file list.
    expect(sent.messages[1]).toEqual({ role: 'user', content: 'make a site' })
    expect(sent.messages[2]).toEqual({ role: 'assistant', content: 'Created three files.' })
    expect(sent.messages[3]!.content).toContain('old heading')
    expect(sent.messages[4]).toEqual({ role: 'user', content: 'retitle it' })
  })

  it('fails a stale revision before the provider call', async () => {
    const userId = createUser()
    seedWorkspace(userId, [{ path: 'index.html', data: Buffer.from('<h1>x</h1>') }], 'index.html')
    const { provider, origin } = await serveChat(sendManifest(LANDING_MANIFEST))
    const before = workspaceFingerprint(userId)

    const response = await postChat(origin, { message: 'hi', revision: 0 }, { cookie: session(userId) })

    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe('workspace_conflict')
    expect(provider.requests).toHaveLength(0)
    expect(workspaceFingerprint(userId)).toEqual(before)
  })
})

describe('POST /api/ai/chat failure atomicity', () => {
  const invalidManifests: unknown[] = [
    { summary: 'removes the entry file', files: [{ op: 'delete', path: 'index.html' }] },
    { summary: 'unknown op', files: [{ op: 'rename', path: 'index.html' }] },
    { summary: 'extra key', files: [{ op: 'add', path: 'index.html', content: 'x', mode: 'append' }] },
    { summary: 'unsafe path', files: [{ op: 'add', path: '../escape.html', content: 'x' }] },
    { summary: 'missing update', files: [{ op: 'update', path: 'nope.html', content: 'x' }] },
    {
      summary: 'delete absent',
      files: [
        { op: 'delete', path: 'nope.html' },
        { op: 'add', path: 'index.html', content: 'x' },
      ],
    },
    {
      summary: 'duplicate',
      files: [
        { op: 'add', path: 'index.html', content: 'x' },
        { op: 'add', path: 'index.html', content: 'y' },
      ],
    },
    {
      summary: 'collision',
      files: [
        { op: 'add', path: 'index.html', content: 'x' },
        { op: 'add', path: 'index.html/a.html', content: 'y' },
      ],
    },
  ]

  it('returns 502 for invalid model output and leaves the committed bytes and revision untouched', async () => {
    const userId = createUser()
    seedWorkspace(userId, [{ path: 'index.html', data: Buffer.from('<h1>kept</h1>') }], 'index.html')
    const before = workspaceFingerprint(userId)
    const generationsBefore = generationNames(userId)

    for (const manifest of invalidManifests) {
      const { provider, origin } = await serveChat(sendManifest(manifest))
      const response = await postChat(origin, { message: 'do it', revision: 1 }, { cookie: session(userId) })

      expect(response.status).toBe(502)
      expect((await response.json()).error.code).toBe('invalid_model_output')
      expect(provider.requests).toHaveLength(1)
      expect(workspaceFingerprint(userId)).toEqual(before)
      expect(generationNames(userId)).toEqual(generationsBefore)
    }

    // Every failed turn is recorded honestly, and none of them enter history.
    const row = getAiWorkspace(userId)!
    const messages = getAiMessages(userId, row.session_id)
    expect(messages).toHaveLength(invalidManifests.length * 2)
    expect(messages.every((message) => message.status === 'error')).toBe(true)
    const assistant = messages.find((message) => message.role === 'assistant')!
    expect(assistant).toMatchObject({
      error_code: 'invalid_model_output',
      model: 'test-model-returned',
      input_tokens: 2400,
    })
  })

  it('returns 502 for fenced JSON and a truncated completion, applying nothing', async () => {
    const userId = createUser()
    seedWorkspace(userId, [{ path: 'index.html', data: Buffer.from('<h1>kept</h1>') }], 'index.html')
    const before = workspaceFingerprint(userId)

    const fenced = await serveChat(sendManifest(`\`\`\`json\n${JSON.stringify(LANDING_MANIFEST)}\n\`\`\``))
    const fencedResponse = await postChat(
      fenced.origin,
      { message: 'go', revision: 1 },
      { cookie: session(userId) }
    )
    expect(fencedResponse.status).toBe(502)
    expect((await fencedResponse.json()).error.code).toBe('invalid_model_output')
    expect(workspaceFingerprint(userId)).toEqual(before)

    const truncated = await serveChat(
      respondWithJson({
        choices: [
          { message: { role: 'assistant', content: '{"summary":"s","files":[{"op":"add"' }, finish_reason: 'length' },
        ],
      })
    )
    const truncatedResponse = await postChat(
      truncated.origin,
      { message: 'go', revision: 1 },
      { cookie: session(userId) }
    )
    expect(truncatedResponse.status).toBe(502)
    expect((await truncatedResponse.json()).error.code).toBe('provider_failed')
    expect(workspaceFingerprint(userId)).toEqual(before)
  })

  it('returns 502 for a provider error without surfacing its body, applying nothing', async () => {
    const userId = createUser()
    seedWorkspace(userId, [{ path: 'index.html', data: Buffer.from('<h1>kept</h1>') }], 'index.html')
    const before = workspaceFingerprint(userId)

    const providerError = await serveChat(respondWithJson({ error: 'provider internals' }, 500))
    const response = await postChat(
      providerError.origin,
      { message: 'go', revision: 1 },
      { cookie: session(userId) }
    )

    expect(response.status).toBe(502)
    const body = await response.json()
    expect(body.error.code).toBe('provider_failed')
    expect(JSON.stringify(body)).not.toContain('provider internals')
    expect(workspaceFingerprint(userId)).toEqual(before)

    const row = getAiWorkspace(userId)!
    const assistant = getAiMessages(userId, row.session_id).find((message) => message.role === 'assistant')!
    expect(assistant).toMatchObject({
      status: 'error',
      error_code: 'provider_failed',
      content: 'The model provider call failed.',
    })
  })

  it('reports missing provider usage as null and falls back to the requested model', async () => {
    const userId = createUser()
    const { origin } = await serveChat(sendManifest(LANDING_MANIFEST, { model: undefined, usage: undefined }))

    const response = await postChat(origin, { message: 'go', revision: 0 }, { cookie: session(userId) })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.usage.model).toBe(REQUESTED_MODEL)
    expect(body.usage.input_tokens).toBeNull()
    expect(body.usage.output_tokens).toBeNull()
    expect(Number.isSafeInteger(body.usage.duration_ms)).toBe(true)

    const row = getAiWorkspace(userId)!
    const assistant = getAiMessages(userId, row.session_id).find((message) => message.role === 'assistant')!
    expect(assistant).toMatchObject({ model: REQUESTED_MODEL, input_tokens: null, output_tokens: null, status: 'ok' })
  })
})

describe('POST /api/ai/chat concurrency and budget', () => {
  it('refuses a second same-user turn with 409 while the provider call is in flight', async () => {
    const userId = createUser()
    const otherUserId = createUser()
    const held = Promise.withResolvers<void>()
    let heldResponse: ServerResponse | null = null
    // The first provider request is held open; every later one answers normally.
    const provider = await startProvider((req, res, captured) => {
      if (heldResponse === null) {
        heldResponse = res
        held.resolve()
        return
      }
      sendManifest(LANDING_MANIFEST)(req, res, captured)
    })
    vi.stubEnv('JOLT_AI_API_KEY', TEST_KEY)
    vi.stubEnv('JOLT_AI_BASE_URL', provider.baseUrl)
    vi.stubEnv('JOLT_AI_MODEL', REQUESTED_MODEL)
    const origin = await startApp(await loadChatHandler())

    const heldRequest = postChat(origin, { message: 'hold me', revision: 0 }, { cookie: session(userId) })
    await held.promise
    expect(isAiOperationActive(userId)).toBe(true)

    const sameUser = await postChat(origin, { message: 'again', revision: 0 }, { cookie: session(userId) })
    expect(sameUser.status).toBe(409)
    expect((await sameUser.json()).error.code).toBe('workspace_busy')
    expect(provider.requests).toHaveLength(1)

    const otherUser = await postChat(origin, { message: 'mine', revision: 0 }, { cookie: session(otherUserId) })
    expect(otherUser.status).toBe(200)
    expect(provider.requests).toHaveLength(2)

    const payload = JSON.stringify(manifestEnvelope(LANDING_MANIFEST))
    heldResponse!.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
    heldResponse!.end(payload)
    expect((await heldRequest).status).toBe(200)

    // The guard is released on success and the slot is reusable: the next turn
    // reaches the provider instead of being refused as busy.
    expect(isAiOperationActive(userId)).toBe(false)
    const nextTurn = await postChat(origin, { message: 'next turn', revision: 1 }, { cookie: session(userId) })
    expect(nextTurn.status).not.toBe(409)
    expect(provider.requests).toHaveLength(3)
  })

  it('releases the guard after a failed turn', async () => {
    const userId = createUser()
    const { origin } = await serveChat(respondWithJson({ error: 'boom' }, 500))

    const failed = await postChat(origin, { message: 'go', revision: 0 }, { cookie: session(userId) })

    expect(failed.status).toBe(502)
    expect(isAiOperationActive(userId)).toBe(false)
  })

  it('returns 429 with Retry-After once the hourly budget is spent, without calling the provider', async () => {
    const userId = createUser()
    const { provider, origin } = await serveChat(sendManifest(LANDING_MANIFEST))
    for (let attempt = 0; attempt < AI_CHAT_RATE_MAX; attempt += 1) checkAiChatRateLimit(userId)

    const response = await postChat(origin, { message: 'go', revision: 0 }, { cookie: session(userId) })

    expect(response.status).toBe(429)
    const body = await response.json()
    expect(body.error.code).toBe('rate_limited')
    expect(Number.isSafeInteger(body.retry_after)).toBe(true)
    expect(response.headers.get('retry-after')).toBe(String(body.retry_after))
    expect(provider.requests).toHaveLength(0)
  })

  it('spends the budget on failed provider attempts too', async () => {
    const userId = createUser()
    const { origin } = await serveChat(respondWithJson({ error: 'boom' }, 500))
    const cookie = session(userId)

    for (let attempt = 0; attempt < AI_CHAT_RATE_MAX; attempt += 1) {
      const response = await postChat(origin, { message: `attempt ${attempt}`, revision: 0 }, { cookie })
      expect(response.status).toBe(502)
    }

    const refused = await postChat(origin, { message: 'one too many', revision: 0 }, { cookie })
    expect(refused.status).toBe(429)
    expect((await refused.json()).error.code).toBe('rate_limited')
  }, 30_000)
})
