import { createHmac, timingSafeEqual } from 'crypto'
import { getCookie, setCookie } from 'h3'
import type { H3Event } from 'h3'

const COOKIE_NAME = 'jolt_web'
const SESSION_MAX_AGE_SEC = 24 * 60 * 60 // 24 hours
const SECRET = process.env.JOLT_WEB_SECRET || process.env.JOLT_VIEW_SECRET || 'jolt-web-default-change-in-production'

function getSigningKey(): Buffer {
  return Buffer.from(SECRET, 'utf8')
}

function sign(expiry: string): string {
  return createHmac('sha256', getSigningKey()).update(`web|${expiry}`).digest('base64url')
}

export function createWebSession(): { value: string } {
  const expiry = String(Date.now() + SESSION_MAX_AGE_SEC * 1000)
  const sig = sign(expiry)
  return { value: `${expiry}:${sig}` }
}

export function verifyWebSession(cookieValue: string | undefined): boolean {
  if (!cookieValue || typeof cookieValue !== 'string') return false
  const parts = cookieValue.split(':')
  if (parts.length !== 2) return false
  const [expiry, sig] = parts
  if (Number(expiry) < Date.now()) return false
  const expectedSig = sign(expiry)
  if (sig.length !== expectedSig.length) return false
  return timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expectedSig, 'utf8'))
}

export function setWebSessionCookie(event: H3Event): void {
  const { value } = createWebSession()
  setCookie(event, COOKIE_NAME, value, {
    path: '/',
    maxAge: SESSION_MAX_AGE_SEC,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  })
}

export function hasValidWebSession(event: H3Event): boolean {
  const cookie = getCookie(event, COOKIE_NAME)
  return verifyWebSession(cookie)
}
