import { readBody } from 'h3'
import { requireUser } from '~/server/utils/user-auth'
import { findUserById, updateUserPassword } from '~/server/utils/db'
import { verifyPassword, hashPassword } from '~/server/utils/password'

export default defineEventHandler(async (event) => {
  const userId = requireUser(event)
  const body = await readBody(event).catch(() => ({}))
  const currentPassword = typeof body?.currentPassword === 'string' ? body.currentPassword : ''
  const newPassword = typeof body?.newPassword === 'string' ? body.newPassword : ''

  if (newPassword.length < 8 || newPassword.length > 200) {
    throw createError({ statusCode: 400, message: 'New password must be between 8 and 200 characters' })
  }

  const user = await findUserById(event, userId)
  if (!user) {
    throw createError({ statusCode: 401, message: 'Unauthorized' })
  }

  const valid = await verifyPassword(currentPassword, user.password_hash)
  if (!valid) {
    throw createError({ statusCode: 401, message: 'Current password is incorrect' })
  }

  const newHash = await hashPassword(newPassword)
  await updateUserPassword(event, userId, newHash)

  return { ok: true }
})
