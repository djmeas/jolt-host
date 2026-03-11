import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { createWebSession } from '~/server/utils/web-session'

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

  beforeAll(() => {
    const { value } = createWebSession()
    cookie = `jolt_web=${value}`
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
      headers: { Cookie: cookie },
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
  })

  it('returns url_with_unlock when password is provided', async () => {
    const html = readFileSync(join(FIXTURES, 'dummy.html'))
    const form = new FormData()
    form.append('file', new Blob([html], { type: 'text/html' }), 'dummy.html')
    form.append('password', 'test-secret')

    const res = await fetch(`${getBaseUrl()}/api/upload`, {
      method: 'POST',
      body: form,
      headers: { Cookie: cookie },
    })
    const data = (await res.json()) as Record<string, string>

    expect(res.ok).toBe(true)
    expect(data.url_with_unlock).toBeDefined()
    expect(data.url_with_unlock).toContain('?unlock=')
    expect(data.url_with_unlock).not.toContain('password=')
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
})
