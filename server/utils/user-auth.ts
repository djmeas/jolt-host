import { createHmac, timingSafeEqual } from 'crypto'
import { getCookie, setCookie, deleteCookie } from 'h3'
import type { H3Event } from 'h3'

const COOKIE_NAME = 'jolt_user'
const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60 // 30 days
const SECRET = process.env.JOLT_USER_SECRET || process.env.JOLT_VIEW_SECRET || 'changeme'

function getSigningKey(): Buffer {
  return Buffer.from(SECRET, 'utf8')
}

function sign(userId: string, expiry: string): string {
  return createHmac('sha256', getSigningKey()).update(`user|${userId}|${expiry}`).digest('base64url')
}

export function setUserCookie(event: H3Event, userId: string): void {
  const expiry = String(Date.now() + SESSION_MAX_AGE_SEC * 1000)
  const sig = sign(userId, expiry)
  const value = `${userId}:${expiry}:${sig}`
  setCookie(event, COOKIE_NAME, value, {
    path: '/',
    maxAge: SESSION_MAX_AGE_SEC,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  })
}

export function clearUserCookie(event: H3Event): void {
  deleteCookie(event, COOKIE_NAME, { path: '/' })
}

export function getUserIdFromEvent(event: H3Event): string | null {
  const cookie = getCookie(event, COOKIE_NAME)
  if (!cookie || typeof cookie !== 'string') return null
  const parts = cookie.split(':')
  if (parts.length !== 3) return null
  const [userId, expiry, sig] = parts
  if (Number(expiry) < Date.now()) return null
  const expectedSig = sign(userId, expiry)
  if (sig.length !== expectedSig.length) return null
  const valid = timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expectedSig, 'utf8'))
  return valid ? userId : null
}

export function requireUser(event: H3Event): string {
  const userId = getUserIdFromEvent(event)
  if (!userId) {
    throw createError({ statusCode: 401, message: 'Unauthorized' })
  }
  return userId
}
