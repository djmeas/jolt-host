import { createHmac, timingSafeEqual } from 'crypto'
import { getCookie, setCookie } from 'h3'
import type { H3Event } from 'h3'

const COOKIE_NAME = 'jolt_view'
const COOKIE_MAX_AGE_DAYS = 30
const SECRET = process.env.JOLT_VIEW_SECRET || 'jolt-view-default-change-in-production'

function getSigningKey(): Buffer {
  return Buffer.from(SECRET, 'utf8')
}

function sign(slug: string, expiry: string): string {
  const data = `${slug}|${expiry}`
  return createHmac('sha256', getSigningKey()).update(data).digest('base64url')
}

export function createViewToken(slug: string): { value: string; expiry: string } {
  const expiry = String(Date.now() + COOKIE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000)
  const sig = sign(slug, expiry)
  const value = `${slug}:${expiry}:${sig}`
  return { value, expiry }
}

export function verifyViewToken(slug: string, cookieValue: string | undefined): boolean {
  if (!cookieValue || typeof cookieValue !== 'string') return false
  const parts = cookieValue.split(':')
  if (parts.length !== 3) return false
  const [cookieSlug, expiry, sig] = parts
  if (cookieSlug !== slug) return false
  if (Number(expiry) < Date.now()) return false
  const expectedSig = sign(slug, expiry)
  if (sig.length !== expectedSig.length) return false
  return timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expectedSig, 'utf8'))
}

export function setViewAuthCookie(event: H3Event, slug: string): void {
  const { value, expiry } = createViewToken(slug)
  const maxAge = COOKIE_MAX_AGE_DAYS * 24 * 60 * 60
  setCookie(event, COOKIE_NAME, value, {
    path: '/',
    maxAge,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  })
}

export function getViewAuthCookie(event: H3Event): string | undefined {
  return getCookie(event, COOKIE_NAME)
}

export function isViewAuthorized(event: H3Event, slug: string): boolean {
  return verifyViewToken(slug, getViewAuthCookie(event))
}
