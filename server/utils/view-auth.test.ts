import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getCookie: vi.fn(),
  setCookie: vi.fn(),
}))

vi.mock('h3', () => ({
  getCookie: mocks.getCookie,
  setCookie: mocks.setCookie,
}))

describe('view-auth', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('authorizes any slug present in a multi-token cookie', async () => {
    const { createViewToken, isViewAuthorized } = await import('./view-auth')
    const first = createViewToken('alpha').value
    const second = createViewToken('beta').value
    mocks.getCookie.mockReturnValue(`${first};${second}`)

    expect(isViewAuthorized({} as never, 'beta')).toBe(true)
    expect(isViewAuthorized({} as never, 'gamma')).toBe(false)
  })

  it('prepends a new token and preserves other slugs', async () => {
    const { createViewToken, setViewAuthCookie } = await import('./view-auth')
    const existing = createViewToken('alpha').value
    mocks.getCookie.mockReturnValue(existing)

    setViewAuthCookie({} as never, 'beta')

    expect(mocks.setCookie).toHaveBeenCalledTimes(1)
    const [, , value] = mocks.setCookie.mock.calls[0]
    expect(value).toContain('beta:')
    expect(value).toContain(existing)
  })
})
