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
      env: {
        ...process.env,
        NODE_ENV: 'test',
        // Deliberately unusable *build-time* origins. The real origins are only
        // supplied when the server starts, so the tests prove that management
        // pages use the runtime JOLT_SITE_BASE_ORIGIN rather than whatever was
        // baked into the bundle.
        JOLT_APP_ORIGIN: 'http://stale-build-app.invalid',
        JOLT_SITE_BASE_ORIGIN: 'http://stale-build-sites.invalid',
      },
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
    env: {
      ...process.env,
      PORT: port,
      NODE_ENV: 'test',
      JOLT_TEST_MODE: '1',
      REGISTERED_USERS_ONLY: 'true',
      ENABLE_REGISTRATION: 'false',
      ENABLE_LANDING_PAGE: process.env.ENABLE_LANDING_PAGE ?? 'false',
      NUXT_JOLTHOST_ADMIN_PASSWORD: 'test-admin-password',
      // Test-only origin isolation and signing secrets. Production requires a
      // separately registered hosted origin with wildcard DNS/TLS.
      JOLT_APP_ORIGIN: `http://127.0.0.1:${port}`,
      JOLT_SITE_BASE_ORIGIN: `http://sites.localhost:${port}`,
      JOLT_VIEW_SECRET: 'test-view-secret-value',
      JOLT_DATA_SESSION_SECRET: 'test-data-session-secret-value',
      JOLT_WEB_SECRET: 'test-web-secret-value',
      JOLT_USER_SECRET: 'test-user-secret-value',
      JOLT_ADMIN_SECRET: 'test-admin-secret-value',
      // No NUXT_PUBLIC_JOLTHOST_*_ORIGIN override on purpose: management pages
      // must derive their links from these runtime values, not from the stale
      // origins baked into the bundle.
    },
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
