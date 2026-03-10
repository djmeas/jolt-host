import { describe, it, expect, vi } from 'vitest'
import { createAdminSession, verifyAdminSession } from './admin-auth'

describe('admin-auth', () => {
  describe('createAdminSession', () => {
    it('returns value in expiry:sig format', () => {
      const { value, expiry } = createAdminSession()
      expect(value).toContain(':')
      const [exp, sig] = value.split(':')
      expect(exp).toBe(expiry)
      expect(sig.length).toBeGreaterThan(0)
    })
  })

  describe('verifyAdminSession', () => {
    it('returns true for valid session', () => {
      const { value } = createAdminSession()
      expect(verifyAdminSession(value)).toBe(true)
    })

    it('returns false for undefined or empty', () => {
      expect(verifyAdminSession(undefined)).toBe(false)
      expect(verifyAdminSession('')).toBe(false)
    })

    it('returns false for invalid format', () => {
      expect(verifyAdminSession('invalid')).toBe(false)
      expect(verifyAdminSession('only-one-part')).toBe(false)
    })

    it('returns false for expired session', () => {
      vi.useFakeTimers()
      const { value } = createAdminSession()
      vi.advanceTimersByTime(25 * 60 * 60 * 1000) // 25 hours
      expect(verifyAdminSession(value)).toBe(false)
      vi.useRealTimers()
    })
  })
})
