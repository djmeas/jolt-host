import { readBody } from 'h3'
import { randomUUID } from 'crypto'
import { hashPassword } from '~/server/utils/password'
import { insertUser, findUserByEmail, getConfig } from '~/server/utils/db'
import { setUserCookie } from '~/server/utils/user-auth'

export default defineEventHandler(async (event) => {
  if ((await getConfig(event, 'auth_enabled', '0')) !== '1') {
    throw createError({ statusCode: 403, message: 'Registration is currently disabled' })
  }
  const body = await readBody(event).catch(() => ({}))
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  const email = typeof body?.email === 'string' ? body.email.trim() : ''
  const password = typeof body?.password === 'string' ? body.password : ''

  if (!name) {
    throw createError({ statusCode: 400, message: 'Name is required' })
  }
  if (!email || !email.includes('@')) {
    throw createError({ statusCode: 400, message: 'A valid email is required' })
  }
  if (password.length < 8 || password.length > 200) {
    throw createError({ statusCode: 400, message: 'Password must be between 8 and 200 characters' })
  }

  const existing = await findUserByEmail(event, email)
  if (existing) {
    throw createError({ statusCode: 409, message: 'A user with this email already exists' })
  }

  const id = randomUUID()
  const passwordHash = await hashPassword(password)
  await insertUser(event, id, name, email, passwordHash)
  setUserCookie(event, id)

  return { ok: true, user: { id, name, email } }
})
