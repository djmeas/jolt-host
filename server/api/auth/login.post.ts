import { readBody } from 'h3'
import { findUserByEmail, getConfig } from '~/server/utils/db'
import { verifyPassword } from '~/server/utils/password'
import { setUserCookie } from '~/server/utils/user-auth'

export default defineEventHandler(async (event) => {
  if ((await getConfig(event, 'auth_enabled', '0')) !== '1') {
    throw createError({ statusCode: 403, message: 'Login is currently disabled' })
  }
  const body = await readBody(event).catch(() => ({}))
  const email = typeof body?.email === 'string' ? body.email.trim() : ''
  const password = typeof body?.password === 'string' ? body.password : ''

  if (!email || !password) {
    throw createError({ statusCode: 401, message: 'Invalid credentials' })
  }

  const user = await findUserByEmail(event, email)
  if (!user) {
    throw createError({ statusCode: 401, message: 'Invalid credentials' })
  }

  const valid = await verifyPassword(password, user.password_hash)
  if (!valid) {
    throw createError({ statusCode: 401, message: 'Invalid credentials' })
  }

  setUserCookie(event, user.id)
  return { ok: true, user: { id: user.id, name: user.name, email: user.email } }
})
