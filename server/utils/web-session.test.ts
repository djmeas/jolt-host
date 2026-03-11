import { describe, it, expect, vi } from 'vitest'
import { createWebSession, verifyWebSession } from './web-session'

describe('web-session', () => {
  describe('createWebSession', () => {
    it('returns value in expiry:sig format', () => {
      const { value } = createWebSession()
      expect(value).toContain(':')
      const [expiry, sig] = value.split(':')
      expect(expiry).toBeDefined()
      expect(sig.length).toBeGreaterThan(0)
    })
  })

  describe('verifyWebSession', () => {
    it('returns true for valid session', () => {
      const { value } = createWebSession()
      expect(verifyWebSession(value)).toBe(true)
    })

    it('returns false for undefined or empty', () => {
      expect(verifyWebSession(undefined)).toBe(false)
      expect(verifyWebSession('')).toBe(false)
    })

    it('returns false for invalid format', () => {
      expect(verifyWebSession('invalid')).toBe(false)
      expect(verifyWebSession('only-one-part')).toBe(false)
    })

    it('returns false for expired session', () => {
      vi.useFakeTimers()
      const { value } = createWebSession()
      vi.advanceTimersByTime(25 * 60 * 60 * 1000) // 25 hours
      expect(verifyWebSession(value)).toBe(false)
      vi.useRealTimers()
    })
  })
})
