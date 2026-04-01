import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readBody: vi.fn(),
  setAdminCookie: vi.fn(),
}))

vi.mock('h3', () => ({
  readBody: mocks.readBody,
}))

vi.mock('~/server/utils/admin-auth', () => ({
  setAdminCookie: mocks.setAdminCookie,
}))

describe('admin login API', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.readBody.mockResolvedValue({ password: 'alpha' })
    ;(globalThis as typeof globalThis & {
      defineEventHandler: <T>(handler: T) => T
      useRuntimeConfig: ReturnType<typeof vi.fn>
      createError: (input: { statusCode: number; message: string }) => Error & {
        statusCode: number
        message: string
      }
    }).defineEventHandler = <T>(handler: T) => handler
    ;(globalThis as typeof globalThis & {
      useRuntimeConfig: ReturnType<typeof vi.fn>
    }).useRuntimeConfig = vi.fn((event?: unknown) => {
      if (event) {
        return { jolthost: { adminPassword: 'alpha' } }
      }
      return { jolthost: { adminPassword: '' } }
    })
    ;(globalThis as typeof globalThis & {
      createError: (input: { statusCode: number; message: string }) => Error & {
        statusCode: number
        message: string
      }
    }).createError = ({ statusCode, message }) =>
      Object.assign(new Error(message), { statusCode, message })
  })

  it('reads admin password from request runtime config', async () => {
    const event = { context: { nitro: {} } }
    const handler = (await import('./login.post')).default

    await expect(handler(event as never)).resolves.toEqual({ ok: true })
    expect(globalThis.useRuntimeConfig).toHaveBeenCalledWith(event)
    expect(mocks.setAdminCookie).toHaveBeenCalledWith(event)
  })
})
