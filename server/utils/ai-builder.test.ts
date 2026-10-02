import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AI_CHAT_BODY_MAX_BYTES,
  AI_HISTORY_MAX_BYTES,
  AI_HISTORY_MAX_PAIRS,
  AI_MANIFEST_SUMMARY_MAX_BYTES,
  AI_MESSAGE_CONTENT_MAX_BYTES,
  AI_PROVIDER_TIMEOUT_MS,
  AI_RESPONSE_MAX_BYTES,
  AI_SYSTEM_PROMPT,
  aiBuilderAvailable,
  aiChatCompletion,
  buildAiChatMessages,
  parseAiManifest,
  resolveAiConfig,
  type AiChatMessage,
} from './ai-builder'
import { resolveAiChatUrl } from './ai-settings'
import { AI_MAX_MANIFEST_OPERATIONS, AI_MAX_WORKSPACE_FILES } from './ai-workspace'

const TEST_KEY = 'test-key-not-a-real-credential'

type CapturedRequest = { url: string; headers: IncomingMessage['headers']; json: unknown; raw: string }

const openServers: Server[] = []

/** A real loopback HTTP provider: provider behavior is exercised over the wire. */
async function startProvider(respond: (req: IncomingMessage, res: ServerResponse, captured: CapturedRequest) => void) {
  const requests: CapturedRequest[] = []
  const server = createServer((req, res) => {
    res.on('error', () => {})
    req.on('error', () => {})
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let json: unknown = null
      try {
        json = JSON.parse(raw)
      } catch {
        json = null
      }
      const captured: CapturedRequest = { url: req.url ?? '', headers: req.headers, json, raw }
      requests.push(captured)
      respond(req, res, captured)
    })
  })
  openServers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests, server }
}

async function closeProvider(server: Server) {
  const index = openServers.indexOf(server)
  if (index >= 0) openServers.splice(index, 1)
  await new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
}

function respondWithJson(body: unknown, status = 200) {
  return (_req: IncomingMessage, res: ServerResponse) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
    res.end(payload)
  }
}

const chatEnvelope = {
  id: 'chatcmpl-test',
  object: 'chat.completion',
  model: 'test-model-returned',
  choices: [
    { index: 0, message: { role: 'assistant', content: '{"summary":"ok","files":[]}' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 34 },
}

function configure(baseUrl: string, overrides: Record<string, string> = {}) {
  vi.stubEnv('JOLT_AI_API_KEY', TEST_KEY)
  vi.stubEnv('JOLT_AI_BASE_URL', baseUrl)
  vi.stubEnv('JOLT_AI_MODEL', 'test-model')
  vi.stubEnv('ENABLE_AI_BUILDER', 'true')
  for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value)
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        })
    )
  )
})

describe('aiBuilderAvailable', () => {
  it('fails closed without a key even when everything else is configured', () => {
    vi.stubEnv('JOLT_AI_API_KEY', '')
    vi.stubEnv('JOLT_AI_BASE_URL', 'https://gateway.example.com/v1')
    vi.stubEnv('JOLT_AI_MODEL', 'example/model')
    expect(aiBuilderAvailable()).toBe(false)

    vi.stubEnv('JOLT_AI_API_KEY', '   ')
    expect(aiBuilderAvailable()).toBe(false)
  })

  it('is true only for a complete, valid configuration', () => {
    configure('https://gateway.example.com/v1')
    expect(aiBuilderAvailable()).toBe(true)
    expect(resolveAiConfig()).toEqual({
      available: true,
      config: {
        apiKey: TEST_KEY,
        model: 'test-model',
        baseUrl: 'https://gateway.example.com/v1',
        chatUrl: 'https://gateway.example.com/v1/chat/completions',
      },
    })
  })

  it('treats only the literal string "false" as disabled', () => {
    for (const value of ['0', 'FALSE', 'no', '', 'true']) {
      configure('https://gateway.example.com/v1', { ENABLE_AI_BUILDER: value })
      expect(aiBuilderAvailable()).toBe(true)
    }
    configure('https://gateway.example.com/v1', { ENABLE_AI_BUILDER: 'false' })
    expect(aiBuilderAvailable()).toBe(false)
  })

  it('requires a model and a valid base URL', () => {
    configure('https://gateway.example.com/v1', { JOLT_AI_MODEL: '' })
    expect(resolveAiConfig()).toMatchObject({ available: false, reason: 'ai_model_missing' })

    for (const base of ['', 'gateway.example.com/v1', '/v1', 'ftp://gateway.example.com', 'http://gateway.example.com/v1']) {
      configure(base)
      expect(resolveAiConfig()).toMatchObject({ available: false, reason: 'ai_base_invalid' })
    }
  })

  it('allows loopback HTTP so a local provider can be used', () => {
    for (const base of ['http://127.0.0.1:8080/v1', 'http://localhost:8080/v1', 'http://[::1]:8080/v1']) {
      configure(base)
      expect(aiBuilderAvailable()).toBe(true)
    }
  })

  it('pins the protocol byte bounds and timeout', () => {
    expect(AI_CHAT_BODY_MAX_BYTES).toBe(8192)
    expect(AI_MESSAGE_CONTENT_MAX_BYTES).toBe(16384)
    expect(AI_RESPONSE_MAX_BYTES).toBe(8 * 1024 * 1024)
    expect(AI_PROVIDER_TIMEOUT_MS).toBe(60_000)
  })
})

describe('resolveAiChatUrl', () => {
  it('appends /chat/completions exactly once', () => {
    expect(resolveAiChatUrl('https://gateway.example.com/v1')).toBe('https://gateway.example.com/v1/chat/completions')
    expect(resolveAiChatUrl('https://gateway.example.com/v1/')).toBe('https://gateway.example.com/v1/chat/completions')
    expect(resolveAiChatUrl('https://gateway.example.com/v1/chat/completions')).toBe(
      'https://gateway.example.com/v1/chat/completions'
    )
    expect(resolveAiChatUrl('https://gateway.example.com')).toBe('https://gateway.example.com/chat/completions')
  })

  it('rejects relative URLs, unsupported schemes, userinfo, query, and fragment', () => {
    for (const raw of [
      '/v1',
      'gateway.example.com/v1',
      'ftp://gateway.example.com/v1',
      'https://user:secret@gateway.example.com/v1',
      'https://user@gateway.example.com/v1',
      'https://gateway.example.com/v1?key=secret',
      'https://gateway.example.com/v1#fragment',
    ]) {
      expect(resolveAiChatUrl(raw)).toBeNull()
    }
  })
})

describe('aiChatCompletion', () => {
  it('does not call the provider when configuration is missing', async () => {
    const provider = await startProvider(respondWithJson(chatEnvelope))
    vi.stubEnv('JOLT_AI_API_KEY', '')

    const result = await aiChatCompletion({ messages: [{ role: 'user', content: 'hello' }] })

    expect(result).toMatchObject({ ok: false, code: 'ai_unavailable' })
    expect(provider.requests).toHaveLength(0)
  })

  it('posts the fixed request shape once and returns content plus reported usage', async () => {
    const provider = await startProvider(respondWithJson(chatEnvelope))
    configure(provider.baseUrl)

    const result = await aiChatCompletion({
      messages: [
        { role: 'system', content: 'server-owned prompt' },
        { role: 'user', content: 'build me a site' },
      ],
    })

    expect(result).toMatchObject({
      ok: true,
      content: '{"summary":"ok","files":[]}',
      model: 'test-model-returned',
      inputTokens: 12,
      outputTokens: 34,
    })
    if (result.ok) expect(result.durationMs).toBeGreaterThanOrEqual(0)

    expect(provider.requests).toHaveLength(1)
    const request = provider.requests[0]!
    expect(request.url).toBe('/v1/chat/completions')
    expect(request.headers.authorization).toBe(`Bearer ${TEST_KEY}`)
    expect(request.json).toMatchObject({
      model: 'test-model',
      max_tokens: 32768,
      stream: false,
      n: 1,
      messages: [
        { role: 'system', content: 'server-owned prompt' },
        { role: 'user', content: 'build me a site' },
      ],
    })
  })

  it('never returns the key in its result', async () => {
    const provider = await startProvider(respondWithJson(chatEnvelope))
    configure(provider.baseUrl)

    const result = await aiChatCompletion({ messages: [{ role: 'user', content: 'hi' }] })

    expect(JSON.stringify(result)).not.toContain(TEST_KEY)
  })

  it('reports absent or nonsensical usage as null and falls back to no model', async () => {
    const provider = await startProvider(
      respondWithJson({
        choices: [{ message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: -1, completion_tokens: 1.5 },
      })
    )
    configure(provider.baseUrl)

    const result = await aiChatCompletion({ messages: [{ role: 'user', content: 'hi' }] })

    expect(result).toMatchObject({ ok: true, model: null, inputTokens: null, outputTokens: null })
  })

  it('fails on non-2xx without surfacing the provider body', async () => {
    const provider = await startProvider(respondWithJson({ error: 'provider internals' }, 500))
    configure(provider.baseUrl)

    const result = await aiChatCompletion({ messages: [{ role: 'user', content: 'hi' }] })

    expect(result).toMatchObject({ ok: false, code: 'provider_failed' })
    expect(JSON.stringify(result)).not.toContain('provider internals')
    expect(provider.requests).toHaveLength(1)
  })

  it('fails on malformed JSON, truncation, tool calls, extra choices, and non-text content', async () => {
    const bodies: unknown[] = [
      'not json at all',
      { choices: [{ message: { content: 'x' }, finish_reason: 'length' }] },
      { choices: [{ message: { content: 'x', tool_calls: [{ id: 'call_1' }] }, finish_reason: 'stop' }] },
      {
        choices: [
          { message: { content: 'a' }, finish_reason: 'stop' },
          { message: { content: 'b' }, finish_reason: 'stop' },
        ],
      },
      { choices: [{ message: { content: { files: [] } }, finish_reason: 'stop' }] },
      { choices: [] },
      '[]',
    ]

    for (const body of bodies) {
      const provider = await startProvider(respondWithJson(body))
      configure(provider.baseUrl)

      const result = await aiChatCompletion({ messages: [{ role: 'user', content: 'hi' }] })

      expect(result).toMatchObject({ ok: false, code: 'provider_failed' })
      expect(provider.requests).toHaveLength(1)
    }
  })

  it('aborts a chunked response that exceeds the byte cap without a Content-Length', async () => {
    const provider = await startProvider((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      const chunk = Buffer.alloc(64 * 1024, 0x61)
      let written = 0
      const pump = () => {
        try {
          while (written <= AI_RESPONSE_MAX_BYTES) {
            written += chunk.length
            if (!res.write(chunk)) {
              res.once('drain', pump)
              return
            }
          }
          res.end()
        } catch {
          res.destroy()
        }
      }
      pump()
    })
    configure(provider.baseUrl)

    const result = await aiChatCompletion({ messages: [{ role: 'user', content: 'hi' }] })

    expect(result).toMatchObject({ ok: false, code: 'provider_response_too_large' })
    expect(provider.requests).toHaveLength(1)
  })

  it('times out a held response', async () => {
    const provider = await startProvider(() => {})
    configure(provider.baseUrl)

    // The 60-second production timeout is not shortened; this uses the internal
    // override so the test exercises the real timer path quickly.
    const result = await aiChatCompletion({ messages: [{ role: 'user', content: 'hi' }], timeoutMs: 80 })

    expect(result).toMatchObject({ ok: false, code: 'provider_timeout' })
    expect(provider.requests).toHaveLength(1)
  })

  it('stops when the caller cancels', async () => {
    const controller = new AbortController()
    // Cancelled exactly when the provider has received the request, so the test
    // never waits on a guessed duration.
    const provider = await startProvider(() => controller.abort())
    configure(provider.baseUrl)

    const result = await aiChatCompletion({
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
      timeoutMs: 30_000,
    })

    expect(result).toMatchObject({ ok: false, code: 'provider_failed' })
    expect(provider.requests).toHaveLength(1)
  })

  it('fails when the provider cannot be reached', async () => {
    const provider = await startProvider(respondWithJson(chatEnvelope))
    const baseUrl = provider.baseUrl
    await closeProvider(provider.server)
    configure(baseUrl)

    const result = await aiChatCompletion({ messages: [{ role: 'user', content: 'hi' }] })

    expect(result).toMatchObject({ ok: false, code: 'provider_failed' })
  })
})

function json(value: unknown): string {
  return JSON.stringify(value)
}

describe('parseAiManifest', () => {
  it('accepts the documented add/update/delete vocabulary', () => {
    const result = parseAiManifest(
      json({
        summary: 'Created a landing page.',
        files: [
          { op: 'add', path: 'index.html', content: '<!doctype html><h1>Hi</h1>' },
          { op: 'add', path: 'styles/site.css', content: 'body { color: red }' },
          { op: 'update', path: 'scripts/site.js', content: '' },
          { op: 'delete', path: 'old-page.html' },
        ],
      })
    )

    expect(result).toEqual({
      ok: true,
      summary: 'Created a landing page.',
      operations: [
        { op: 'add', path: 'index.html', content: '<!doctype html><h1>Hi</h1>' },
        { op: 'add', path: 'styles/site.css', content: 'body { color: red }' },
        { op: 'update', path: 'scripts/site.js', content: '' },
        { op: 'delete', path: 'old-page.html' },
      ],
    })
  })

  it('accepts the maximum operation count and rejects one more', () => {
    const atLimit = Array.from({ length: AI_MAX_MANIFEST_OPERATIONS }, (_value, index) => ({
      op: 'add',
      path: `page-${index}.html`,
      content: 'x',
    }))
    expect(parseAiManifest(json({ summary: 'many', files: atLimit }))).toMatchObject({ ok: true })

    const overLimit = [...atLimit, { op: 'add', path: 'one-more.html', content: 'x' }]
    expect(parseAiManifest(json({ summary: 'many', files: overLimit }))).toMatchObject({ ok: false })
  })

  it('rejects anything that is not exactly one JSON object with summary and files', () => {
    const rejected: string[] = [
      '',
      'not json',
      '```json\n{"summary":"s","files":[]}\n```',
      'Sure! Here is your site: {"summary":"s","files":[]}',
      json([]),
      json(null),
      json('{"summary":"s","files":[]}'),
      json({ summary: 's' }),
      json({ files: [] }),
      json({ summary: 's', files: [], extra: true }),
      json({ summary: 's', files: [], Summary: 'dupe' }),
    ]
    for (const content of rejected) {
      const result = parseAiManifest(content)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.message).not.toContain('Here is your site')
    }
  })

  it('rejects a missing, nonblank-violating, or oversized summary', () => {
    expect(parseAiManifest(json({ summary: 4, files: [] }))).toMatchObject({ ok: false })
    expect(parseAiManifest(json({ summary: '   ', files: [] }))).toMatchObject({ ok: false })
    expect(parseAiManifest(json({ summary: 's', files: [] }))).toMatchObject({ ok: false })

    const tooLong = 'a'.repeat(AI_MANIFEST_SUMMARY_MAX_BYTES + 1)
    expect(parseAiManifest(json({ summary: tooLong, files: [{ op: 'delete', path: 'a.html' }] }))).toMatchObject({
      ok: false,
    })
    const atLimit = 'a'.repeat(AI_MANIFEST_SUMMARY_MAX_BYTES)
    expect(parseAiManifest(json({ summary: atLimit, files: [{ op: 'delete', path: 'a.html' }] }))).toMatchObject({
      ok: true,
    })
  })

  it('rejects operation objects with the wrong keys for their vocabulary', () => {
    const rejected: unknown[] = [
      { op: 'add', path: 'a.html' },
      { op: 'add', path: 'a.html', content: 'x', extra: 1 },
      { op: 'update', path: 'a.html' },
      { op: 'update', path: 'a.html', content: 'x', mode: 'append' },
      { op: 'delete', path: 'a.html', content: '' },
      { op: 'delete', path: 'a.html', reason: 'gone' },
      { op: 'rename', path: 'a.html', content: 'x' },
      { op: 'add', path: 'a.html', content: 42 },
      { op: 'add', path: 'a.html', content: { text: 'x' } },
      { op: 'add', content: 'x' },
      { op: 'add', path: 'a.html', Content: 'x' },
      'nope',
      null,
      [],
    ]
    for (const operation of rejected) {
      expect(parseAiManifest(json({ summary: 's', files: [operation] })).ok).toBe(false)
    }
  })

  it('rejects non-textual content and any path the workspace validator refuses', () => {
    const withContent = (path: unknown, content: unknown) => json({ summary: 's', files: [{ op: 'add', path, content }] })

    expect(parseAiManifest(withContent('a.html', 'a\u0000b')).ok).toBe(false)
    expect(parseAiManifest(withContent('a.html', 'lone \ud800 surrogate')).ok).toBe(false)
    // A well-formed surrogate pair is legal text.
    expect(parseAiManifest(withContent('a.html', 'emoji 😀')).ok).toBe(true)

    const unsafePaths: unknown[] = [
      '',
      '/index.html',
      'index.html/',
      'a//b.html',
      './index.html',
      'a/./b.html',
      '../index.html',
      String.raw`a\b.html`,
      'C:/index.html',
      'a:b.html',
      'a%2eb.html',
      '.hidden/x.html',
      '_jolt/x.html',
      'api/x.html',
      'a'.repeat(241) + '.html',
      `${'a'.repeat(101)}/x.html`,
      42,
      null,
    ]
    for (const path of unsafePaths) {
      expect(parseAiManifest(withContent(path, 'x')).ok).toBe(false)
    }
  })
})

describe('buildAiChatMessages', () => {
  const editableFiles = [
    { path: 'index.html', content: '<h1>current</h1>' },
    { path: 'styles/site.css', content: 'body { color: red }' },
  ]

  function workspaceObject(messages: AiChatMessage[]): Record<string, unknown> {
    const delimited = messages.find((message) => message.content.startsWith('<current_workspace>'))!
    return JSON.parse(delimited.content.replace('<current_workspace>\n', '').replace('\n</current_workspace>', ''))
  }

  it('sends the server-owned system prompt, the workspace, and the message', () => {
    const messages = buildAiChatMessages({
      revision: 3,
      entryFile: 'index.html',
      editableFiles,
      history: [],
      userMessage: 'make the heading bigger',
    })

    expect(messages[0]).toEqual({ role: 'system', content: AI_SYSTEM_PROMPT })
    expect(AI_SYSTEM_PROMPT).toContain('"summary"')
    expect(AI_SYSTEM_PROMPT).toContain('"files"')
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: 'make the heading bigger' })

    expect(workspaceObject(messages)).toEqual({
      entry_file: 'index.html',
      revision: 3,
      limits: {
        max_files: AI_MAX_WORKSPACE_FILES,
        max_file_bytes: 1024 * 1024,
        max_total_bytes: 5 * 1024 * 1024,
        max_operations: AI_MAX_MANIFEST_OPERATIONS,
      },
      files: editableFiles,
    })
  })

  it('replays successful pairs oldest first and drops half-turns', () => {
    const history = Array.from({ length: AI_HISTORY_MAX_PAIRS + 2 }, (_value, index) => ({
      user: `user message ${index}`,
      assistant: `assistant summary ${index}`,
    }))

    const messages = buildAiChatMessages({ revision: 0, entryFile: 'index.html', editableFiles, history, userMessage: 'next' })

    const replayed = messages.filter((message) => message.role !== 'system').slice(0, -2)
    expect(replayed.map((message) => message.content)).toEqual([
      'user message 2',
      'assistant summary 2',
      'user message 3',
      'assistant summary 3',
      'user message 4',
      'assistant summary 4',
      'user message 5',
      'assistant summary 5',
    ])
  })

  it('drops oldest complete pairs to stay inside the history byte budget', () => {
    const big = (index: number) => `pair-${index}-${'x'.repeat(10 * 1024)}`
    const history = [0, 1, 2].map((index) => ({ user: big(index), assistant: big(index) }))
    history.push({ user: 'small', assistant: 'small' })
    expect(4 * 2 * 10 * 1024).toBeGreaterThan(AI_HISTORY_MAX_BYTES)

    const messages = buildAiChatMessages({ revision: 0, entryFile: 'index.html', editableFiles, history, userMessage: 'next' })

    const content = messages.map((message) => message.content)
    // The newest pair fits and is replayed whole; the oversized older pairs are
    // dropped whole, never partially, so the transcript is a run of complete turns.
    expect(content.filter((value) => value === big(2))).toHaveLength(2)
    expect(content.filter((value) => value === 'small')).toHaveLength(2)
    expect(content).not.toContain(big(0))
    expect(content).not.toContain(big(1))
  })

  it('always includes current file contents even when history is empty', () => {
    const messages = buildAiChatMessages({
      revision: 0,
      entryFile: 'index.html',
      editableFiles: [{ path: 'index.html', content: 'created in turn one' }],
      history: [],
      userMessage: 'change it',
    })
    const content = messages.map((message) => message.content).join('\n')
    expect(content).toContain('created in turn one')
    expect(content).not.toContain('<current_workspace>{"entry_file"')
  })
})
