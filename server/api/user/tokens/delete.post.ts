import { readBody } from 'h3'
import { requireUser } from '~/server/utils/user-auth'
import { deleteApiTokenByNicknameAndUserId } from '~/server/utils/db'

export default defineEventHandler(async (event) => {
  const userId = requireUser(event)
  const body = await readBody(event).catch(() => ({}))
  const nickname = typeof body?.nickname === 'string' ? body.nickname.trim() : ''
  if (!nickname) {
    throw createError({ statusCode: 400, message: 'Nickname is required' })
  }
  const deleted = deleteApiTokenByNicknameAndUserId(nickname, userId)
  if (!deleted) {
    throw createError({ statusCode: 404, message: 'Token not found' })
  }
  return { ok: true }
})
