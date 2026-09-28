import { readBody } from 'h3'
import { requireUser } from '~/server/utils/user-auth'
import { insertApiToken, findApiTokenByNickname } from '~/server/utils/db'
import { createTokenWithNickname } from '~/server/utils/api-token'

export default defineEventHandler(async (event) => {
  const userId = requireUser(event)
  const body = await readBody(event).catch(() => ({}))
  const nickname = typeof body?.nickname === 'string' ? body.nickname.trim() : ''
  if (!nickname) {
    throw createError({ statusCode: 400, message: 'Nickname is required' })
  }
  if (nickname.length > 64) {
    throw createError({ statusCode: 400, message: 'Nickname too long' })
  }
  if (findApiTokenByNickname(nickname)) {
    throw createError({ statusCode: 409, message: 'A token with this nickname already exists' })
  }
  const { id, raw, hash } = createTokenWithNickname(nickname)
  insertApiToken(id, nickname, hash, userId)
  return {
    token: raw,
    nickname,
    id,
    message: 'Copy this token now. It will not be shown again.',
  }
})
