import { getRequestHeader } from 'h3'
import type { H3Event } from 'h3'
import { hashApiToken } from '~/server/utils/api-token'
import { findApiTokenByHash, findUserById } from '~/server/utils/db'
import { hasValidWebSession } from '~/server/utils/web-session'
import { getUserIdFromEvent } from '~/server/utils/user-auth'
import { registeredUsersOnly } from '~/server/utils/upload-mode'

export function hasValidApiToken(event: H3Event): boolean {
  const auth = getRequestHeader(event, 'authorization')
  if (!auth || typeof auth !== 'string') return false
  const match = auth.match(/^Bearer\s+(.+)$/i)
  if (!match) return false
  const token = match[1].trim()
  if (!token.startsWith('jolt_')) return false
  const hash = hashApiToken(token)
  return findApiTokenByHash(hash) !== undefined
}

export function isAuthorizedToUpload(event: H3Event): boolean {
  const userId = getUserIdFromEvent(event)
  if (registeredUsersOnly()) return userId !== null && findUserById(userId) !== null
  if (userId !== null) return true
  return hasValidApiToken(event) || hasValidWebSession(event)
}

export function requireUploadAuthorization(event: H3Event): void {
  if (isAuthorizedToUpload(event)) return
  throw createError({
    statusCode: 401,
    statusMessage: 'Unauthorized',
    message: registeredUsersOnly()
      ? 'Log in with a registered account to publish.'
      : 'API token required for programmatic uploads. Use the web form at / or provide an API token in the Authorization header.',
  })
}
