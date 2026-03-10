import { createHmac, timingSafeEqual } from 'crypto'
import { getCookie, setCookie, deleteCookie } from 'h3'
import type { H3Event } from 'h3'

const COOKIE_NAME = 'jolt_admin'
const SESSION_MAX_AGE_SEC = 24 * 60 * 60 // 24 hours
const SECRET = process.env.JOLT_ADMIN_SECRET || process.env.JOLT_VIEW_SECRET || 'jolt-admin-default-change-in-production'

function getSigningKey(): Buffer {
  return Buffer.from(SECRET, 'utf8')
}

function sign(expiry: string): string {
  return createHmac('sha256', getSigningKey()).update(`admin|${expiry}`).digest('base64url')
}

export function createAdminSession(): { value: string; expiry: string } {
  const expiry = String(Date.now() + SESSION_MAX_AGE_SEC * 1000)
  const sig = sign(expiry)
  return { value: `${expiry}:${sig}`, expiry }
}

export function verifyAdminSession(cookieValue: string | undefined): boolean {
  if (!cookieValue || typeof cookieValue !== 'string') return false
  const parts = cookieValue.split(':')
  if (parts.length !== 2) return false
  const [expiry, sig] = parts
  if (Number(expiry) < Date.now()) return false
  const expectedSig = sign(expiry)
  if (sig.length !== expectedSig.length) return false
  return timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expectedSig, 'utf8'))
}

export function setAdminCookie(event: H3Event): void {
  const { value } = createAdminSession()
  setCookie(event, COOKIE_NAME, value, {
    path: '/',
    maxAge: SESSION_MAX_AGE_SEC,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  })
}

export function clearAdminCookie(event: H3Event): void {
  deleteCookie(event, COOKIE_NAME, { path: '/' })
}

export function isAdminAuthenticated(event: H3Event): boolean {
  const cookie = getCookie(event, COOKIE_NAME)
  return verifyAdminSession(cookie)
}

export function requireAdmin(event: H3Event): void {
  if (!isAdminAuthenticated(event)) {
    throw createError({ statusCode: 401, message: 'Unauthorized' })
  }
}
