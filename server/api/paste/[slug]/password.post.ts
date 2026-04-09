import { getRouterParam, readBody } from 'h3'
import { findUploadBySlug, updatePasswordBySlugAndOwnerToken } from '~/server/utils/db'
import { hashPassword } from '~/server/utils/password'

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')
  if (!slug) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }
  const body = await readBody(event).catch(() => ({}))
  const ownerToken = typeof body?.owner_token === 'string' ? body.owner_token.trim() : ''
  const password = typeof body?.password === 'string' ? body.password.trim() : ''
  if (!ownerToken) {
    throw createError({ statusCode: 400, message: 'Missing owner token' })
  }
  if (!password) {
    throw createError({ statusCode: 400, message: 'Password is required' })
  }
  if (password.length > 200) {
    throw createError({ statusCode: 400, message: 'Password too long' })
  }
  const row = await findUploadBySlug(event, slug)
  if (!row) {
    throw createError({ statusCode: 404, message: 'Paste not found' })
  }
  const ok = await updatePasswordBySlugAndOwnerToken(event, slug, ownerToken, await hashPassword(password))
  if (!ok) {
    throw createError({ statusCode: 403, message: 'Invalid owner token' })
  }
  return { ok: true }
})
