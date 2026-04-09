import { readBody, getRouterParam } from 'h3'
import { requireAdmin } from '~/server/utils/admin-auth'
import { findUserById, updateUserPassword } from '~/server/utils/db'
import { hashPassword } from '~/server/utils/password'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, message: 'User ID is required' })
  }

  const body = await readBody(event).catch(() => ({}))
  const newPassword = typeof body?.newPassword === 'string' ? body.newPassword : ''

  if (newPassword.length < 8 || newPassword.length > 200) {
    throw createError({ statusCode: 400, message: 'Password must be between 8 and 200 characters' })
  }

  const user = await findUserById(event, id)
  if (!user) {
    throw createError({ statusCode: 404, message: 'User not found' })
  }

  const hash = await hashPassword(newPassword)
  await updateUserPassword(event, id, hash)

  return { ok: true }
})
