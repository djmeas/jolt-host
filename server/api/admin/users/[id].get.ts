import { getRouterParam } from 'h3'
import { requireAdmin } from '~/server/utils/admin-auth'
import { findUserById } from '~/server/utils/db'

export default defineEventHandler((event) => {
  requireAdmin(event)
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, message: 'User ID is required' })
  }

  const user = findUserById(id)
  if (!user) {
    throw createError({ statusCode: 404, message: 'User not found' })
  }

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    upload_max_bytes: user.upload_max_bytes,
    never_expire: user.never_expire,
    created_at: user.created_at,
    updated_at: user.updated_at,
  }
})
