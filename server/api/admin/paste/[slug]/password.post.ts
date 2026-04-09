import { getRouterParam, readBody } from 'h3'
import { requireAdmin } from '~/server/utils/admin-auth'
import { findUploadBySlug, updatePasswordBySlug } from '~/server/utils/db'
import { hashPassword } from '~/server/utils/password'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const slug = getRouterParam(event, 'slug')
  if (!slug) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }
  const row = await findUploadBySlug(event, slug)
  if (!row) {
    throw createError({ statusCode: 404, message: 'Paste not found' })
  }
  const body = await readBody(event).catch(() => ({}))
  const password = typeof body?.password === 'string' ? body.password.trim() : ''

  if (password.length > 200) {
    throw createError({ statusCode: 400, message: 'Password too long' })
  }

  const passwordHash = password.length > 0 ? await hashPassword(password) : null
  await updatePasswordBySlug(event, slug, passwordHash)
  return { ok: true }
})
