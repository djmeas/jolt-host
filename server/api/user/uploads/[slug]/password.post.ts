import { readBody, getRouterParam } from 'h3'
import { requireUser } from '~/server/utils/user-auth'
import { findUploadBySlug, updatePasswordBySlug } from '~/server/utils/db'
import { hashPassword } from '~/server/utils/password'

export default defineEventHandler(async (event) => {
  const userId = requireUser(event)
  const slug = getRouterParam(event, 'slug')
  if (!slug) {
    throw createError({ statusCode: 400, message: 'Slug is required' })
  }

  const upload = await findUploadBySlug(event, slug)
  if (!upload) {
    throw createError({ statusCode: 404, message: 'Upload not found' })
  }

  if (upload.user_id !== userId) {
    throw createError({ statusCode: 403, message: 'Forbidden' })
  }

  const body = await readBody(event).catch(() => ({}))
  const password = typeof body?.password === 'string' ? body.password.trim() : ''

  if (password.length > 0) {
    const passwordHash = await hashPassword(password)
    await updatePasswordBySlug(event, slug, passwordHash)
  } else {
    await updatePasswordBySlug(event, slug, null)
  }

  return { ok: true }
})
