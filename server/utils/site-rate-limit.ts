import { getRequestHeader, getRequestIP } from 'h3'
import type { H3Event } from 'h3'

/**
 * In-memory rate limits for the site data API and its password form.
 *
 * These are process-local: a multi-instance deployment needs a shared limiter at
 * the edge. Buckets are pruned on access and capped so an attacker cannot grow
 * them without bound.
 */

const LOGIN_FAIL_MAX = 5
const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000
const LOGIN_SITE_MAX = 50
const LOGIN_SITE_WINDOW_MS = 15 * 60 * 1000
const WRITE_MAX = 60
const WRITE_WINDOW_MS = 60 * 1000
const REQUEST_MAX = 120
const REQUEST_WINDOW_MS = 60 * 1000
const MAX_BUCKETS = 10_000

export type RateResult = { allowed: boolean; retryAfter?: number }

type Buckets = Map<string, number[]>

const loginFailures: Buckets = new Map()
const loginAttempts: Buckets = new Map()
const writeBuckets: Buckets = new Map()
const requestBuckets: Buckets = new Map()

function pruneBucket(store: Buckets, key: string, windowMs: number, now: number): number[] {
  const timestamps = store.get(key)
  if (!timestamps) return []
  const valid = timestamps.filter((t) => now - t < windowMs)
  if (valid.length === 0) store.delete(key)
  else store.set(key, valid)
  return valid
}

function pruneAll(store: Buckets, windowMs: number, now: number): void {
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

function take(store: Buckets, key: string, windowMs: number, max: number, now: number): RateResult {
  pruneAll(store, windowMs, now)
  // A full map of live buckets refuses new keys instead of growing without
  // bound under distributed attempts. Buckets for keys already tracked keep
  // working normally.
  if (!store.has(key) && store.size >= MAX_BUCKETS) {
    return { allowed: false, retryAfter: Math.ceil(windowMs / 1000) }
  }
  const timestamps = pruneBucket(store, key, windowMs, now)
  if (timestamps.length >= max) {
    return { allowed: false, retryAfter: retryAfterFor(timestamps, windowMs, now) }
  }
  timestamps.push(now)
  store.set(key, timestamps)
  return { allowed: true }
}

/**
 * Consumes one password-form attempt for a site, after checking both the
 * per-IP failure budget and the site-wide attempt budget.
 */
export function takeLoginAttempt(siteId: string, ip: string, now: number = Date.now()): RateResult {
  const failures = pruneBucket(loginFailures, `${siteId}|${ip}`, LOGIN_FAIL_WINDOW_MS, now)
  if (failures.length >= LOGIN_FAIL_MAX) {
    return { allowed: false, retryAfter: retryAfterFor(failures, LOGIN_FAIL_WINDOW_MS, now) }
  }
  return take(loginAttempts, siteId, LOGIN_SITE_WINDOW_MS, LOGIN_SITE_MAX, now)
}

export function recordLoginFailure(siteId: string, ip: string, now: number = Date.now()): void {
  pruneAll(loginFailures, LOGIN_FAIL_WINDOW_MS, now)
  const key = `${siteId}|${ip}`
  // Never grow the map past its cap; the login attempt budget for a full map
  // already returns 429, so dropping the record cannot open a bypass.
  if (!loginFailures.has(key) && loginFailures.size >= MAX_BUCKETS) return
  const timestamps = pruneBucket(loginFailures, key, LOGIN_FAIL_WINDOW_MS, now)
  timestamps.push(now)
  loginFailures.set(key, timestamps)
}

/** Every data API request counts against a per-site budget. */
export function checkDataRequestRate(siteId: string, now: number = Date.now()): RateResult {
  return take(requestBuckets, siteId, REQUEST_WINDOW_MS, REQUEST_MAX, now)
}

/** Writes additionally count against a per-data-session budget. */
export function checkDataWriteRate(
  siteId: string,
  sessionKey: string,
  now: number = Date.now()
): RateResult {
  return take(writeBuckets, `${siteId}|${sessionKey}`, WRITE_WINDOW_MS, WRITE_MAX, now)
}

/**
 * Client IP for site limits: only from the socket, unless a trusted proxy is
 * explicitly configured. Forwarded headers are never trusted by default.
 */
export function getSiteClientIP(event: H3Event): string {
  if (process.env.JOLT_TRUST_PROXY === 'true') {
    const cloudflare = getRequestHeader(event, 'cf-connecting-ip')
    if (cloudflare?.trim()) return cloudflare.trim()
    return getRequestIP(event, { xForwardedFor: true }) ?? 'unknown'
  }
  return getRequestIP(event, { xForwardedFor: false }) ?? 'unknown'
}

/** Clears every bucket. Tests only. */
export function resetSiteRateLimits(): void {
  loginFailures.clear()
  loginAttempts.clear()
  writeBuckets.clear()
  requestBuckets.clear()
}
