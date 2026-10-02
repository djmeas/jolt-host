import { afterEach, describe, expect, it } from 'vitest'
import {
  AI_CHAT_RATE_MAX,
  AI_CHAT_RATE_WINDOW_MS,
  checkAiChatRateLimit,
  isAiOperationActive,
  releaseAiOperation,
  resetAiOperations,
  resetAiRateLimits,
  tryAcquireAiOperation,
} from './ai-rate-limit'

const WINDOW = AI_CHAT_RATE_WINDOW_MS

afterEach(() => {
  resetAiRateLimits()
  resetAiOperations()
})

describe('checkAiChatRateLimit', () => {
  it('accepts exactly the budget and refuses the next attempt with a Retry-After', () => {
    const now = 1_000_000
    for (let attempt = 0; attempt < AI_CHAT_RATE_MAX; attempt += 1) {
      expect(checkAiChatRateLimit('user-a', now)).toEqual({ allowed: true })
    }

    const refused = checkAiChatRateLimit('user-a', now)
    expect(refused.allowed).toBe(false)
    expect(refused.retryAfter).toBe(Math.ceil(WINDOW / 1000))

    // A refusal is not itself an attempt: the budget only shrinks by accepts.
    expect(checkAiChatRateLimit('user-a', now + WINDOW - 1).allowed).toBe(false)
  })

  it('frees the oldest attempt once the window passes', () => {
    const now = 5_000_000
    for (let attempt = 0; attempt < AI_CHAT_RATE_MAX; attempt += 1) {
      checkAiChatRateLimit('user-a', now)
    }
    expect(checkAiChatRateLimit('user-a', now).allowed).toBe(false)

    // The earliest accepted attempt leaves the window here.
    expect(checkAiChatRateLimit('user-a', now + WINDOW).allowed).toBe(true)
    expect(checkAiChatRateLimit('user-a', now + WINDOW + 1).allowed).toBe(true)
  })

  it('counts attempts per account, never per caller or IP', () => {
    const now = 9_000_000
    for (let attempt = 0; attempt < AI_CHAT_RATE_MAX; attempt += 1) {
      checkAiChatRateLimit('user-a', now)
    }
    expect(checkAiChatRateLimit('user-a', now).allowed).toBe(false)
    expect(checkAiChatRateLimit('user-b', now)).toEqual({ allowed: true })
  })

  it('prunes expired buckets instead of holding them forever', () => {
    const now = 20_000_000
    checkAiChatRateLimit('user-a', now)
    checkAiChatRateLimit('user-b', now)
    checkAiChatRateLimit('user-c', now + WINDOW)

    // user-a and user-b expired long ago; a later refusal must not resurrect
    // their stale timestamps.
    for (let attempt = 0; attempt < AI_CHAT_RATE_MAX; attempt += 1) {
      expect(checkAiChatRateLimit('user-b', now + 2 * WINDOW).allowed).toBe(true)
    }
    expect(checkAiChatRateLimit('user-b', now + 2 * WINDOW).allowed).toBe(false)
  })
})

describe('operation guard', () => {
  it('owns one slot per account and releases it explicitly', () => {
    expect(tryAcquireAiOperation('user-a')).toBe(true)
    expect(isAiOperationActive('user-a')).toBe(true)
    expect(tryAcquireAiOperation('user-a')).toBe(false)

    releaseAiOperation('user-a')
    expect(isAiOperationActive('user-a')).toBe(false)
    expect(tryAcquireAiOperation('user-a')).toBe(true)
  })

  it('keeps different accounts independent', () => {
    expect(tryAcquireAiOperation('user-a')).toBe(true)
    expect(tryAcquireAiOperation('user-b')).toBe(true)
    releaseAiOperation('user-a')
    expect(isAiOperationActive('user-b')).toBe(true)
  })

  it('releases on a thrown operation, as the endpoint guard does in a finally', () => {
    expect(tryAcquireAiOperation('user-a')).toBe(true)
    try {
      throw new Error('provider exploded')
    } catch {
      // Mirrors the endpoint: the slot is always released in a finally block.
    } finally {
      releaseAiOperation('user-a')
    }
    expect(isAiOperationActive('user-a')).toBe(false)
  })

  it('releasing an unheld slot is harmless', () => {
    releaseAiOperation('nobody')
    expect(isAiOperationActive('nobody')).toBe(false)
  })
})
