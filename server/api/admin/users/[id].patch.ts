import { readBody, getRouterParam } from 'h3'
import { requireAdmin } from '~/server/utils/admin-auth'
import { findUserById, updateUserNameEmail, updateUserLimits, updateUserAiBuild } from '~/server/utils/db'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, message: 'User ID is required' })
  }

  const user = findUserById(id)
  if (!user) {
    throw createError({ statusCode: 404, message: 'User not found' })
  }

  const body = await readBody(event).catch(() => ({}))
  const name = typeof body?.name === 'string' ? body.name.trim() : undefined
  const email = typeof body?.email === 'string' ? body.email.trim() : undefined
  const uploadMaxBytes = body?.upload_max_bytes !== undefined ? (typeof body.upload_max_bytes === 'number' ? body.upload_max_bytes : null) : undefined
  const neverExpire = body?.never_expire !== undefined ? (body.never_expire === 1 || body.never_expire === true ? 1 : 0) : undefined
  const aiBuildEnabled = body?.ai_build_enabled !== undefined
    ? body.ai_build_enabled === 1 || body.ai_build_enabled === true
    : undefined

  if (name !== undefined || email !== undefined) {
    updateUserNameEmail(id, name ?? user.name, email ?? user.email)
  }

  if (uploadMaxBytes !== undefined || neverExpire !== undefined) {
    updateUserLimits(
      id,
      uploadMaxBytes !== undefined ? uploadMaxBytes : user.upload_max_bytes,
      neverExpire !== undefined ? neverExpire : user.never_expire
    )
  }
  if (aiBuildEnabled !== undefined) updateUserAiBuild(id, aiBuildEnabled)

  const updated = findUserById(id)!
  return {
    id: updated.id,
    name: updated.name,
    email: updated.email,
    upload_max_bytes: updated.upload_max_bytes,
    never_expire: updated.never_expire,
    ai_build_enabled: updated.ai_build_enabled,
    created_at: updated.created_at,
    updated_at: updated.updated_at,
  }
})
