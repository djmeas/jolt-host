import { describe, it, expect, beforeEach, vi } from 'vitest'
import { checkUploadRateLimit, resetRateLimitStore } from './rate-limit'

describe('checkUploadRateLimit', () => {
  beforeEach(() => {
    resetRateLimitStore()
    vi.useRealTimers()
  })

  it('allows first request', () => {
    const result = checkUploadRateLimit('192.168.1.1')
    expect(result.allowed).toBe(true)
    expect(result.retryAfter).toBeUndefined()
  })

  it('allows up to 25 requests per IP per hour', () => {
    const ip = '10.0.0.1'
    for (let i = 0; i < 24; i++) {
      const r = checkUploadRateLimit(ip)
      expect(r.allowed).toBe(true)
    }
    const r25 = checkUploadRateLimit(ip)
    expect(r25.allowed).toBe(true)

    const r26 = checkUploadRateLimit(ip)
    expect(r26.allowed).toBe(false)
    expect(r26.retryAfter).toBeDefined()
    expect(r26.retryAfter).toBeGreaterThan(0)
  })

  it('tracks IPs separately', () => {
    for (let i = 0; i < 25; i++) {
      checkUploadRateLimit('ip-a')
    }
    const resultB = checkUploadRateLimit('ip-b')
    expect(resultB.allowed).toBe(true)
  })

  it('returns allowed again after window expires', () => {
    vi.useFakeTimers()
    const ip = '127.0.0.1'
    for (let i = 0; i < 25; i++) {
      checkUploadRateLimit(ip)
    }
    expect(checkUploadRateLimit(ip).allowed).toBe(false)

    vi.advanceTimersByTime(61 * 60 * 1000) // 61 minutes
    const result = checkUploadRateLimit(ip)
    expect(result.allowed).toBe(true)
  })
})
