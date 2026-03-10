import { readBody } from 'h3'
import { requireAdmin } from '~/server/utils/admin-auth'
import { deleteApiTokenByNickname, findApiTokenByNickname } from '~/server/utils/db'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const body = await readBody(event).catch(() => ({}))
  const nickname = typeof body?.nickname === 'string' ? body.nickname.trim() : ''
  if (!nickname) {
    throw createError({ statusCode: 400, message: 'Nickname is required' })
  }
  const existing = findApiTokenByNickname(nickname)
  if (!existing) {
    throw createError({ statusCode: 404, message: 'Token not found' })
  }
  deleteApiTokenByNickname(nickname)
  return { ok: true }
})
