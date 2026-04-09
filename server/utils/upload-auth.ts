import { getRequestHeader } from 'h3'
import type { H3Event } from 'h3'
import { hashApiToken } from '~/server/utils/api-token'
import { findApiTokenByHash } from '~/server/utils/db'
import { hasValidWebSession } from '~/server/utils/web-session'

export async function hasValidApiToken(event: H3Event): Promise<boolean> {
  const auth = getRequestHeader(event, 'authorization')
  if (!auth || typeof auth !== 'string') return false
  const match = auth.match(/^Bearer\s+(.+)$/i)
  if (!match) return false
  const token = match[1].trim()
  if (!token.startsWith('jolt_')) return false
  const hash = hashApiToken(token)
  const row = await findApiTokenByHash(event, hash)
  return row !== null
}

export async function isAuthorizedToUpload(event: H3Event): Promise<boolean> {
  if (hasValidWebSession(event)) return true
  return await hasValidApiToken(event)
}
