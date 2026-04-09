import { readBody } from 'h3'
import { requireAdmin } from '~/server/utils/admin-auth'
import { insertApiToken, findApiTokenByNickname } from '~/server/utils/db'
import { createTokenWithNickname } from '~/server/utils/api-token'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const body = await readBody(event).catch(() => ({}))
  const nickname = typeof body?.nickname === 'string' ? body.nickname.trim() : ''
  if (!nickname) {
    throw createError({ statusCode: 400, message: 'Nickname is required' })
  }
  if (nickname.length > 64) {
    throw createError({ statusCode: 400, message: 'Nickname too long' })
  }
  if (await findApiTokenByNickname(event, nickname)) {
    throw createError({ statusCode: 409, message: 'A token with this nickname already exists' })
  }
  const { id, raw, hash } = createTokenWithNickname(nickname)
  await insertApiToken(event, id, nickname, hash)
  return {
    token: raw,
    nickname,
    id,
    message: 'Copy this token now. It will not be shown again.',
  }
})
