/**
 * In-memory per-IP rate limiting (sliding window).
 * Resets on server restart.
 */

const WINDOW_MS = 60 * 60 * 1000 // 1 hour
const MAX_REQUESTS = 25

const store = new Map<string, number[]>()

function prune(ip: string) {
  const now = Date.now()
  const timestamps = store.get(ip) ?? []
  const valid = timestamps.filter((t) => now - t < WINDOW_MS)
  if (valid.length === 0) store.delete(ip)
  else store.set(ip, valid)
}

export function checkUploadRateLimit(ip: string): { allowed: boolean; retryAfter?: number } {
  prune(ip)
  const timestamps = store.get(ip) ?? []
  const now = Date.now()

  if (timestamps.length >= MAX_REQUESTS) {
    const oldest = Math.min(...timestamps)
    const retryAfter = Math.ceil((oldest + WINDOW_MS - now) / 1000)
    return { allowed: false, retryAfter: Math.max(1, retryAfter) }
  }

  timestamps.push(now)
  store.set(ip, timestamps)
  return { allowed: true }
}

/** Reset the rate limit store. Only for use in tests. */
export function resetRateLimitStore(): void {
  store.clear()
}
