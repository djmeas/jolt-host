import { requireUser } from '~/server/utils/user-auth'
import { findUserById } from '~/server/utils/db'

export default defineEventHandler(async (event) => {
  const userId = requireUser(event)
  const user = await findUserById(event, userId)
  if (!user) {
    throw createError({ statusCode: 401, message: 'Unauthorized' })
  }
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    upload_max_bytes: user.upload_max_bytes,
    never_expire: user.never_expire,
    created_at: user.created_at,
  }
})
