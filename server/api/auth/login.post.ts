import { readBody } from 'h3'
import { findUserByEmail } from '~/server/utils/db'
import { verifyPassword } from '~/server/utils/password'
import { setUserCookie } from '~/server/utils/user-auth'

export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => ({}))
  const email = typeof body?.email === 'string' ? body.email.trim() : ''
  const password = typeof body?.password === 'string' ? body.password : ''

  if (!email || !password) {
    throw createError({ statusCode: 401, message: 'Invalid credentials' })
  }

  const user = findUserByEmail(email)
  if (!user) {
    throw createError({ statusCode: 401, message: 'Invalid credentials' })
  }

  const valid = verifyPassword(password, user.password_hash)
  if (!valid) {
    throw createError({ statusCode: 401, message: 'Invalid credentials' })
  }

  setUserCookie(event, user.id)
  return { ok: true, user: { id: user.id, name: user.name, email: user.email } }
})
