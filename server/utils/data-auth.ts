import { createHash, createHmac, timingSafeEqual } from 'crypto'
import { deleteCookie, getCookie, setCookie } from 'h3'
import type { H3Event } from 'h3'
import type { UploadRow } from '~/server/utils/db'
import { isProductionRuntime } from '~/server/utils/runtime-mode'
import { getSiteHostConfig } from '~/server/utils/site-host'

/**
 * Data-admin sessions for a site's JSON data API.
 *
 * A `jolt_data` cookie is issued only by a Jolt-owned password form POST on the
 * site's own hosted origin. It is separate from the view/unlock credential,
 * which stays read-only, and it binds to the current salted password hash so
 * every password change immediately revokes outstanding write credentials.
 */

const COOKIE_NAME = 'jolt_data'
const COOKIE_PATH = '/_jolt/data'
const COOKIE_TTL_SEC = 24 * 60 * 60
const DEFAULT_VIEW_SECRET = 'jolt-view-default-change-in-production'

export type DataFeatureStatus = { enabled: boolean; reason: string | null }

/** Whether the opt-in site data feature may run at all in this deployment. */
export function getDataFeatureStatus(): DataFeatureStatus {
  const hostConfig = getSiteHostConfig()
  if (!hostConfig.configured) {
    return { enabled: false, reason: hostConfig.reason ?? 'Hosted-origin configuration is incomplete' }
  }
  const secret = process.env.JOLT_DATA_SESSION_SECRET?.trim() ?? ''
  if (secret.length === 0) {
    return { enabled: false, reason: 'JOLT_DATA_SESSION_SECRET is not set' }
  }
  if (isProductionRuntime()) {
    if (secret.length < 16) {
      return { enabled: false, reason: 'JOLT_DATA_SESSION_SECRET must be at least 16 characters' }
    }
    const viewSecret = process.env.JOLT_VIEW_SECRET?.trim() ?? ''
    if (viewSecret.length < 16 || viewSecret === DEFAULT_VIEW_SECRET) {
      return { enabled: false, reason: 'JOLT_VIEW_SECRET must be a strong unique value' }
    }
  }
  return { enabled: true, reason: null }
}

function passwordVersion(passwordHash: string): string {
  return createHash('sha256').update(passwordHash, 'utf8').digest('base64url').slice(0, 22)
}

function signature(siteId: string, expiry: string, version: string): string {
  const secret = process.env.JOLT_DATA_SESSION_SECRET?.trim() ?? ''
  return createHmac('sha256', secret).update(`data|${siteId}|${expiry}|${version}`).digest('base64url')
}

/** Issues a data-admin cookie for a data-enabled, password-protected site. */
export function setDataSessionCookie(event: H3Event, row: UploadRow): boolean {
  const secret = process.env.JOLT_DATA_SESSION_SECRET?.trim() ?? ''
  if (!secret || !row.password_hash || !row.data_enabled) return false
  const expiry = String(Date.now() + COOKIE_TTL_SEC * 1000)
  const value = `${row.id}:${expiry}:${signature(row.id, expiry, passwordVersion(row.password_hash))}`
  setCookie(event, COOKIE_NAME, value, {
    path: COOKIE_PATH,
    maxAge: COOKIE_TTL_SEC,
    httpOnly: true,
    secure: isProductionRuntime(),
    sameSite: 'strict',
  })
  return true
}

export function clearDataSessionCookie(event: H3Event): void {
  deleteCookie(event, COOKIE_NAME, { path: COOKIE_PATH })
}

/**
 * Verifies a data-admin cookie against the site row: immutable site id, expiry,
 * and the row's current password hash must all match.
 */
export function hasValidDataSession(event: H3Event, row: UploadRow): boolean {
  const secret = process.env.JOLT_DATA_SESSION_SECRET?.trim() ?? ''
  if (!secret || !row.password_hash || !row.data_enabled) return false
  const cookie = getCookie(event, COOKIE_NAME)
  if (!cookie || typeof cookie !== 'string') return false
  const parts = cookie.split(':')
  if (parts.length !== 3) return false
  const [siteId, expiry, sig] = parts
  if (siteId !== row.id) return false
  if (!/^\d+$/.test(expiry) || Number(expiry) < Date.now()) return false
  const expected = signature(row.id, expiry, passwordVersion(row.password_hash))
  if (sig.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'))
}

/** Stable, non-reversible key for per-session write rate limits. */
export function getDataSessionKey(event: H3Event): string {
  const cookie = getCookie(event, COOKIE_NAME)
  if (!cookie || typeof cookie !== 'string') return 'anonymous'
  return createHash('sha256').update(cookie, 'utf8').digest('hex').slice(0, 16)
}
