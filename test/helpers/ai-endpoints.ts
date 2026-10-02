/**
 * Shared harness for the unit tests that drive the real `/api/ai/**` handlers
 * over loopback HTTP: real h3 events, real bodies, real headers, real cookies,
 * and a real `node:http` OpenAI-compatible provider mock.
 *
 * Not a test file and not part of the application build.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHmac, randomUUID } from 'node:crypto'
import { createApp, toNodeListener, type EventHandler } from 'h3'
import { deleteAiDataForUser, deleteUser, insertUser } from '~/server/utils/db'
import { deleteWorkspaceForUser } from '~/server/utils/ai-workspace'

export const APP_ORIGIN = 'http://app.test'
export const SITE_ORIGIN = 'http://sites.test'
export const TEST_KEY = 'test-key-not-a-real-credential'
export const REQUESTED_MODEL = 'test-model'

const openServers: Server[] = []
const createdUsers: string[] = []

/** Binds a loopback server on an ephemeral port and returns its origin. */
async function listen(server: Server): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', resolve)
  await promise
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

/** Starts a real HTTP server that dispatches one h3 handler. */
export async function startApp(handler: EventHandler): Promise<string> {
  const app = createApp()
  app.use(handler)
  const server = createServer(toNodeListener(app))
  openServers.push(server)
  return listen(server)
}

export type CapturedRequest = { url: string; headers: IncomingMessage['headers']; json: unknown; raw: string }
export type ProviderResponder = (req: IncomingMessage, res: ServerResponse, captured: CapturedRequest) => void

/** A real loopback provider; provider behavior is exercised over the wire. */
export async function startProvider(respond: ProviderResponder): Promise<{
  baseUrl: string
  requests: CapturedRequest[]
  server: Server
}> {
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
  const baseUrl = await listen(server)
  return { baseUrl: `${baseUrl}/v1`, requests, server }
}

export function respondWithJson(body: unknown, status = 200): ProviderResponder {
  return (_req, res) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
    res.end(payload)
  }
}

/** OpenAI-compatible envelope whose assistant content is the given manifest. */
export function manifestEnvelope(
  manifest: unknown,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: 'test-model-returned',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: typeof manifest === 'string' ? manifest : JSON.stringify(manifest) },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 2400, completion_tokens: 1100 },
    ...overrides,
  }
}

/** Signed registered-user cookie in the app's own session format. */
export function userCookieValue(userId: string): string {
  const expiry = String(Date.now() + 60_000)
  const secret = process.env.JOLT_USER_SECRET || process.env.JOLT_VIEW_SECRET || 'changeme'
  const signature = createHmac('sha256', secret).update(`user|${userId}|${expiry}`).digest('base64url')
  return `${userId}:${expiry}:${signature}`
}

/** Creates a real account row in the shared test database. */
export function createUser(aiBuildEnabled = true): string {
  const id = randomUUID()
  insertUser(id, 'AI Endpoint Test', `${id}@example.test`, 'hash', aiBuildEnabled)
  createdUsers.push(id)
  return id
}

/** Removes accounts, AI rows, and private workspace state created by a test. */
function cleanupUsers(): void {
  for (const id of createdUsers.splice(0)) {
    try {
      deleteAiDataForUser(id)
    } catch {
      // Rows may already be gone when a test deleted the account itself.
    }
    try {
      deleteUser(id)
    } catch {
      // Best effort: a test may have deleted the account already.
    }
    try {
      deleteWorkspaceForUser(id)
    } catch {
      // Best effort filesystem cleanup of the shared test storage directory.
    }
  }
}

export async function closeHarness(): Promise<void> {
  cleanupUsers()
  await Promise.all(
    openServers.splice(0).map(async (server) => {
      const { promise, resolve } = Promise.withResolvers<void>()
      server.closeAllConnections()
      server.close(() => resolve())
      await promise
    })
  )
}
