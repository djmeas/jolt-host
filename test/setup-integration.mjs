/** Builds once, then runs isolated loopback Nitro instances and a local provider. */
import { spawn } from 'node:child_process'
import http from 'node:http'
import { waitForPort } from 'get-port-please'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFileSync, unlinkSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const envPath = join(root, 'test', '.integration-env.json')

async function build() {
  await new Promise((resolve, reject) => {
    const proc = spawn('npm', ['run', 'build'], {
      cwd: root, stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'test', JOLT_APP_ORIGIN: 'http://stale-build-app.invalid', JOLT_SITE_BASE_ORIGIN: 'http://stale-build-sites.invalid' },
    })
    proc.on('error', reject)
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Build failed: ${code}`)))
  })
}

function mockProvider() {
  const queues = new Map()
  const captures = []
  const held = new Map()
  const waiters = new Map()
  const sockets = new Set()
  const json = (res, value, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(value))
  }
  function respond(res, spec) {
    if (spec.kind === 'timeout') return
    if (spec.kind === 'overflow') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      // No Content-Length: exercise consumption, not just header validation.
      for (let i = 0; i < 129; i++) res.write(Buffer.alloc(65536, 120))
      res.end()
      return
    }
    if (spec.kind === 'raw') {
      res.writeHead(spec.status ?? 200, { 'Content-Type': 'application/json' })
      res.end(spec.body)
      return
    }
    json(res, spec.envelope ?? {
      model: 'integration-returned-model',
      choices: [{ finish_reason: spec.finish_reason ?? 'stop', message: {
        role: 'assistant', content: typeof spec.content === 'string' ? spec.content : JSON.stringify(spec.content),
        ...(spec.tool_calls ? { tool_calls: spec.tool_calls } : {}),
      } }],
      ...(spec.usage === null ? {} : { usage: spec.usage ?? { prompt_tokens: 17, completion_tokens: 23 } }),
    }, spec.status ?? 200)
  }
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/control/state') return json(res, { requests: captures, held: [...held.keys()] })
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (req.url === '/control/queue') {
        const queue = queues.get(body.marker) ?? []
        queue.push(body.response)
        queues.set(body.marker, queue)
        return json(res, { queued: queue.length })
      }
      if (req.url === '/control/wait') {
        if (captures.some(capture => capture.marker === body.marker)) return json(res, { observed: true })
        const waiting = waiters.get(body.marker) ?? []
        waiting.push(res)
        waiters.set(body.marker, waiting)
        return
      }
      if (req.url === '/control/release') {
        const pending = held.get(body.marker)
        if (!pending) return json(res, { error: 'No held response' }, 404)
        held.delete(body.marker)
        respond(pending.res, body.response ?? pending.spec)
        return json(res, { released: true })
      }
      if (req.url !== '/v1/chat/completions') return json(res, { error: 'Not found' }, 404)
      const lastMessage = body.messages.at(-1)?.content ?? ''
      const marker = [...queues.keys()].find(key => lastMessage.includes(key))
      const spec = queues.get(marker)?.shift()
      // Store only JSON, never the incoming Authorization header or test key.
      captures.push({ marker: marker ?? null, body })
      if (!spec) return json(res, { error: 'Unqueued integration request' }, 500)
      if (spec.kind === 'hold') {
        held.set(marker, { res, spec: { ...spec, kind: 'success' } })
        res.on('close', () => held.delete(marker))
      } else respond(res, spec)
      for (const waiter of waiters.get(marker) ?? []) json(waiter, { observed: true })
      waiters.delete(marker)
    } catch (error) {
      json(res, { error: String(error) }, 400)
    }
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  return {
    server,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

export default async function setup() {
  const children = []
  const provider = mockProvider()
  await new Promise(resolve => provider.server.listen(0, '127.0.0.1', resolve))
  const providerUrl = `http://127.0.0.1:${provider.server.address().port}`
  const metadata = { JOLT_AI_BASE_URL: `${providerUrl}/v1`, JOLT_AI_CONTROL_URL: `${providerUrl}/control`, JOLT_AI_API_KEY: 'integration-only-not-a-real-key', JOLT_AI_MODEL: 'integration-requested-model' }
  const stop = async () => {
    await Promise.all(children.map(child => new Promise(resolve => {
      if (child.exitCode !== null) return resolve()
      child.once('exit', resolve)
      child.kill('SIGTERM')
    })))
    await provider.close()
    try { unlinkSync(envPath) } catch {}
  }
  try {
    await build()
    const basePort = Number(process.env.JOLT_TEST_PORT || 3847)
    const variants = [
      ['JOLT_TEST_URL', {}],
      ['JOLT_TEST_MISSING_KEY_URL', { JOLT_AI_API_KEY: '' }],
      ['JOLT_TEST_DISABLED_URL', { ENABLE_AI_BUILDER: 'false' }],
      ['JOLT_TEST_OPEN_URL', { REGISTERED_USERS_ONLY: 'false' }],
      ['JOLT_TEST_CAPTCHA_URL', { NUXT_TURNSTILE_SECRET_KEY: 'integration-only-captcha' }],
      ['JOLT_TEST_NO_DATA_URL', { ENABLE_DATA_API_TOGGLE: 'false' }],
      ['JOLT_TEST_NO_HOST_URL', { JOLT_SITE_BASE_ORIGIN: 'http://127.0.0.1:1' }],
      ['JOLT_TEST_NO_DATA_SECRET_URL', { JOLT_DATA_SESSION_SECRET: '' }],
    ]
    for (const [name, overrides] of variants) {
      const port = basePort + children.length
      const url = `http://127.0.0.1:${port}`
      const child = spawn('node', [join(root, '.output/server/index.mjs')], {
        cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test', JOLT_TEST_MODE: '1',
          REGISTERED_USERS_ONLY: 'true', ENABLE_REGISTRATION: 'false', ENABLE_DATA_API_TOGGLE: 'true', ENABLE_AI_BUILDER: 'true',
          ENABLE_LANDING_PAGE: process.env.ENABLE_LANDING_PAGE ?? 'false',
          NUXT_JOLTHOST_ADMIN_PASSWORD: 'test-admin-password', NUXT_TURNSTILE_SECRET_KEY: '',
          JOLT_APP_ORIGIN: url, JOLT_SITE_BASE_ORIGIN: `http://sites.localhost:${port}`,
          JOLT_VIEW_SECRET: 'test-view-secret-value', JOLT_DATA_SESSION_SECRET: 'test-data-session-secret-value',
          JOLT_WEB_SECRET: 'test-web-secret-value', JOLT_USER_SECRET: 'test-user-secret-value', JOLT_ADMIN_SECRET: 'test-admin-secret-value',
          JOLT_AI_BASE_URL: metadata.JOLT_AI_BASE_URL, JOLT_AI_API_KEY: metadata.JOLT_AI_API_KEY, JOLT_AI_MODEL: metadata.JOLT_AI_MODEL,
          ...overrides,
        },
      })
      // Drain pipes so deliberate provider failures cannot fill the child buffer.
      child.stdout.resume()
      child.stderr.resume()
      children.push(child)
      await waitForPort(port, { host: '127.0.0.1', retries: 30 })
      metadata[name] = url
    }
    writeFileSync(envPath, JSON.stringify(metadata))
    return stop
  } catch (error) {
    await stop()
    throw error
  }
}
