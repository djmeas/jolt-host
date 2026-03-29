import { getRequestHeader } from 'h3'
import type { H3Event } from 'h3'
import { hashApiToken } from '~/server/utils/api-token'
import { findApiTokenByHash } from '~/server/utils/db'
import { hasValidWebSession } from '~/server/utils/web-session'
import { getUserIdFromEvent } from '~/server/utils/user-auth'

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
  if (getUserIdFromEvent(event) !== null) return true
  return hasValidApiToken(event) || hasValidWebSession(event)
}
