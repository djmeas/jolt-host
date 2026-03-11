import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword } from './password'

describe('hashPassword', () => {
  it('returns salt:key format', () => {
    const stored = hashPassword('secret123')
    expect(stored).toContain(':')
    const [salt, key] = stored.split(':')
    expect(salt.length).toBeGreaterThan(0)
    expect(key.length).toBeGreaterThan(0)
  })

  it('produces different hashes for same password', () => {
    const a = hashPassword('same')
    const b = hashPassword('same')
    expect(a).not.toBe(b)
  })
})

describe('verifyPassword', () => {
  it('returns true for correct password', () => {
    const stored = hashPassword('mypassword')
    expect(verifyPassword('mypassword', stored)).toBe(true)
  })

  it('returns false for wrong password', () => {
    const stored = hashPassword('mypassword')
    expect(verifyPassword('wrong', stored)).toBe(false)
  })

  it('returns false for empty or invalid stored value', () => {
    expect(verifyPassword('any', '')).toBe(false)
    expect(verifyPassword('any', 'invalid')).toBe(false)
    expect(verifyPassword('any', 'only-one-part')).toBe(false)
  })
})
