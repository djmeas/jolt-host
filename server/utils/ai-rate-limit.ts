/**
 * Per-account AI Builder budgets and the process-local operation guard.
 *
 * Two separate controls, both keyed by the verified account id rather than by
 * IP or upload identity:
 *
 * - A rolling-hour budget of accepted generation attempts. A failed provider
 *   call still consumes an attempt because the operator paid for it.
 * - One in-flight workspace operation per account. Every AI mutation
 *   (chat now; attach/restore/reset/preview later) takes the same guard so a
 *   slow provider call can never race a second mutation for the same account.
 *
 * Both are process-local, like the other limiters in this project: they reset on
 * restart and do not coordinate across replicas. Buckets are pruned on access
 * and capped so distributed attempts cannot grow them without bound.
 */

/** Accepted generation attempts per account per window. */
export const AI_CHAT_RATE_MAX = 30
export const AI_CHAT_RATE_WINDOW_MS = 60 * 60 * 1000
/** Bucket cap; a full map refuses new keys instead of growing without bound. */
const MAX_BUCKETS = 10_000

export type AiRateResult = { allowed: boolean; retryAfter?: number }

const chatBuckets = new Map<string, number[]>()
const activeOperations = new Set<string>()

function pruneBucket(store: Map<string, number[]>, key: string, windowMs: number, now: number): number[] {
  const timestamps = store.get(key)
  if (!timestamps) return []
  const valid = timestamps.filter((t) => now - t < windowMs)
  if (valid.length === 0) store.delete(key)
  else store.set(key, valid)
  return valid
}

function pruneAll(store: Map<string, number[]>, windowMs: number, now: number): void {
  if (store.size < MAX_BUCKETS) return
  for (const [key, timestamps] of store) {
    const valid = timestamps.filter((t) => now - t < windowMs)
    if (valid.length === 0) store.delete(key)
    else store.set(key, valid)
  }
}

function retryAfterFor(timestamps: number[], windowMs: number, now: number): number {
  const oldest = Math.min(...timestamps)
  return Math.max(1, Math.ceil((oldest + windowMs - now) / 1000))
}

/**
 * Consumes one accepted generation attempt for an account. Callers check the
 * client body and revision first so a malformed or stale request never spends
 * the budget.
 */
export function checkAiChatRateLimit(userId: string, now: number = Date.now()): AiRateResult {
  pruneAll(chatBuckets, AI_CHAT_RATE_WINDOW_MS, now)
  if (!chatBuckets.has(userId) && chatBuckets.size >= MAX_BUCKETS) {
    return { allowed: false, retryAfter: Math.ceil(AI_CHAT_RATE_WINDOW_MS / 1000) }
  }
  const timestamps = pruneBucket(chatBuckets, userId, AI_CHAT_RATE_WINDOW_MS, now)
  if (timestamps.length >= AI_CHAT_RATE_MAX) {
    return { allowed: false, retryAfter: retryAfterFor(timestamps, AI_CHAT_RATE_WINDOW_MS, now) }
  }
  timestamps.push(now)
  chatBuckets.set(userId, timestamps)
  return { allowed: true }
}

/** Takes the one slot for this account; false while another operation runs. */
export function tryAcquireAiOperation(userId: string): boolean {
  if (activeOperations.has(userId)) return false
  activeOperations.add(userId)
  return true
}

/** Callers MUST release in a `finally`, including on error and cancellation. */
export function releaseAiOperation(userId: string): void {
  activeOperations.delete(userId)
}

export function isAiOperationActive(userId: string): boolean {
  return activeOperations.has(userId)
}

/** Clears every chat bucket. Tests only. */
export function resetAiRateLimits(): void {
  chatBuckets.clear()
}

/** Clears the operation guard. Tests only. */
export function resetAiOperations(): void {
  activeOperations.clear()
}
