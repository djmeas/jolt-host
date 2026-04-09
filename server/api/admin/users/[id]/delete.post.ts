import { getRouterParam } from 'h3'
import { requireAdmin } from '~/server/utils/admin-auth'
import { findUserById, deleteUser } from '~/server/utils/db'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, message: 'User ID is required' })
  }

  const user = await findUserById(event, id)
  if (!user) {
    throw createError({ statusCode: 404, message: 'User not found' })
  }

  await deleteUser(event, id)
  return { ok: true }
})
