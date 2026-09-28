import { getRequestHeader } from 'h3'
import type { H3Event } from 'h3'
import { hashApiToken } from '~/server/utils/api-token'
import { findApiTokenByHash, findUserById } from '~/server/utils/db'
import type { ApiTokenRow } from '~/server/utils/db'
import { hasValidWebSession } from '~/server/utils/web-session'
import { getUserIdFromEvent } from '~/server/utils/user-auth'
import { registeredUsersOnly } from '~/server/utils/upload-mode'

/** Returns the API token row for the request's Authorization header, if valid. */
export function getApiToken(event: H3Event): ApiTokenRow | undefined {
  const auth = getRequestHeader(event, 'authorization')
  if (!auth || typeof auth !== 'string') return undefined
  const match = auth.match(/^Bearer\s+(.+)$/i)
  if (!match) return undefined
  const token = match[1].trim()
  if (!token.startsWith('jolt_')) return undefined
  return findApiTokenByHash(hashApiToken(token))
}

export function hasValidApiToken(event: H3Event): boolean {
  return getApiToken(event) !== undefined
}

/**
 * The account an upload should be attributed to: a logged-in user takes
 * precedence, otherwise the API token's owner. Unowned tokens yield null.
 */
export function resolveUploadUserId(event: H3Event): string | null {
  return getUserIdFromEvent(event) ?? getApiToken(event)?.user_id ?? null
}

export function isAuthorizedToUpload(event: H3Event): boolean {
  const userId = getUserIdFromEvent(event)
  if (registeredUsersOnly()) {
    if (userId !== null && findUserById(userId) !== null) return true
    return hasValidApiToken(event)
  }
  if (userId !== null) return true
  return hasValidApiToken(event) || hasValidWebSession(event)
}

export function requireUploadAuthorization(event: H3Event): void {
  if (isAuthorizedToUpload(event)) return
  throw createError({
    statusCode: 401,
    statusMessage: 'Unauthorized',
    message: registeredUsersOnly()
      ? 'Log in with a registered account, or provide an API token in the Authorization header, to publish.'
      : 'API token required for programmatic uploads. Use the web form at / or provide an API token in the Authorization header.',
  })
}
