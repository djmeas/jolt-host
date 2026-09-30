import { createError, readBody, sendRedirect, setHeader, setResponseStatus } from 'h3'
import type { H3Event } from 'h3'
import { requireExactOrigin, requireSiteHostRow } from '~/server/utils/site-host'
import { setViewAuthCookie } from '~/server/utils/view-auth'
import { setDataSessionCookie } from '~/server/utils/data-auth'
import { verifyPassword } from '~/server/utils/password'
import {
  getSiteClientIP,
  recordLoginFailure,
  takeLoginAttempt,
} from '~/server/utils/site-rate-limit'

export type PasswordSubmitOptions = {
  /** Reject when the site has no data API (the data login page). */
  requireDataEnabled: boolean
  /** `/_jolt/unlock` only needs an Origin when the POST would grant data-admin. */
  enforceOrigin: 'always' | 'when-data-enabled'
  renderError: (message: string) => string
}

function renderFormResponse(event: H3Event, html: string, statusCode: number) {
  setHeader(event, 'Cache-Control', 'no-store')
  setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
  setResponseStatus(event, statusCode)
  return html
}

/**
 * Handles a Jolt-owned password form POST on a hosted site origin.
 *
 * A successful POST always grants the view cookie, and additionally the
 * data-admin cookie when the site has data enabled. Failure never grants
 * anything; brute force is bounded per IP and per site.
 */
export async function submitSitePassword(event: H3Event, options: PasswordSubmitOptions) {
  const { row, origin } = requireSiteHostRow(event)
  setHeader(event, 'Cache-Control', 'no-store')

  if (!row.password_hash) {
    return sendRedirect(event, '/', 303)
  }
  if (options.requireDataEnabled && !row.data_enabled) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  if (options.enforceOrigin === 'always' || row.data_enabled) {
    try {
      requireExactOrigin(event, origin)
    } catch {
      return renderFormResponse(
        event,
        options.renderError('This request did not come from the site. Reload the page and try again.'),
        403
      )
    }
  }

  const ip = getSiteClientIP(event)
  const attempt = takeLoginAttempt(row.id, ip)
  if (!attempt.allowed) {
    setHeader(event, 'Retry-After', String(attempt.retryAfter ?? 60))
    return renderFormResponse(
      event,
      options.renderError('Too many attempts. Try again later.'),
      429
    )
  }

  const body = await readBody(event).catch(() => ({}))
  const password = typeof body?.password === 'string' ? body.password : ''
  if (!verifyPassword(password, row.password_hash)) {
    recordLoginFailure(row.id, ip)
    return renderFormResponse(event, options.renderError('Wrong password. Try again.'), 401)
  }

  setViewAuthCookie(event, row.slug)
  if (row.data_enabled) setDataSessionCookie(event, row)
  return sendRedirect(event, '/', 303)
}
