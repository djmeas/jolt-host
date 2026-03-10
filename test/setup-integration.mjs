/**
 * Global setup for integration tests: builds Nuxt and starts the server.
 * Run with: npm run test:integration
 */
import { spawn } from 'node:child_process'
import { waitForPort } from 'get-port-please'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFileSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const envPath = join(root, 'test', '.integration-env.json')

async function build() {
  return new Promise((resolve, reject) => {
    const proc = spawn('npm', ['run', 'build'], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'test' },
    })
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Build failed: ${code}`))))
  })
}

export default async function setup() {
  const port = process.env.JOLT_TEST_PORT || '3847'
  const baseUrl = `http://127.0.0.1:${port}`
  await build()
  const server = spawn('node', [join(root, '.output/server/index.mjs')], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: port, NODE_ENV: 'test' },
  })
  await waitForPort(parseInt(port, 10), { retries: 30 })
  writeFileSync(envPath, JSON.stringify({ JOLT_TEST_URL: baseUrl }))
  global.__JOLT_SERVER__ = server

  return () => {
    if (global.__JOLT_SERVER__) {
      global.__JOLT_SERVER__.kill('SIGTERM')
    }
    try {
      const { unlinkSync } = require('node:fs')
      unlinkSync(envPath)
    } catch (_) {}
  }
}
