import { createError } from 'h3'
import type { H3Event } from 'h3'
import { timingSafeEqual } from 'crypto'
import { findUserById } from '~/server/utils/db'
import type { UploadRow } from '~/server/utils/db'
import { getUserIdFromEvent } from '~/server/utils/user-auth'
import { isAdminAuthenticated } from '~/server/utils/admin-auth'
import { registeredUsersOnly } from '~/server/utils/upload-mode'

export type UpdateAuthorizationVia = 'admin' | 'user' | 'owner_token'

/** Constant-time comparison of the stored and provided owner tokens. */
export function ownerTokenMatches(stored: string | null, provided: string): boolean {
  if (!stored || !provided) return false
  const a = Buffer.from(stored, 'utf8')
  const b = Buffer.from(provided, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Authorizes replacing the content of an existing site against that site's row.
 * Web sessions are not ownership proof. In restricted mode, a valid API token
 * counts as an authenticated client, but the owner token must still match.
 * Returns how access was granted, or throws 401/403.
 */
export function authorizeContentUpdate(
  event: H3Event,
  row: UploadRow,
  ownerToken: string,
  isApiClient = false
): UpdateAuthorizationVia {
  if (isAdminAuthenticated(event)) return 'admin'

  const userId = getUserIdFromEvent(event)
  const user = userId ? findUserById(userId) : null
  const tokenMatches = ownerTokenMatches(row.owner_token, ownerToken)

  if (registeredUsersOnly()) {
    if (!user && !isApiClient) {
      throw createError({
        statusCode: 401,
        message: 'Log in with a registered account, or provide an API token, to update this site.',
      })
    }
    if (user && row.user_id && row.user_id === user.id) return 'user'
    if (tokenMatches) return 'owner_token'
    throw createError({ statusCode: 403, message: 'You do not own this site.' })
  }

  if (user && row.user_id && row.user_id === user.id) return 'user'
  if (tokenMatches) return 'owner_token'
  if (!user) {
    throw createError({ statusCode: 401, message: 'Owner token required to update this site.' })
  }
  throw createError({ statusCode: 403, message: 'You do not own this site.' })
}
