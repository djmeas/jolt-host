import { readBody } from 'h3'
import { randomUUID } from 'crypto'
import { requireAdmin } from '~/server/utils/admin-auth'
import { insertUser, findUserByEmail, findUserById, updateUserLimits } from '~/server/utils/db'
import { hashPassword } from '~/server/utils/password'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const body = await readBody(event).catch(() => ({}))
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  const email = typeof body?.email === 'string' ? body.email.trim() : ''
  const password = typeof body?.password === 'string' ? body.password : ''
  const uploadMaxBytes = typeof body?.upload_max_bytes === 'number' ? body.upload_max_bytes : null
  const neverExpire = body?.never_expire === 1 || body?.never_expire === true ? 1 : 0

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

  if (uploadMaxBytes !== null || neverExpire !== 0) {
    await updateUserLimits(event, id, uploadMaxBytes, neverExpire)
  }

  const user = (await findUserById(event, id))!
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    upload_max_bytes: user.upload_max_bytes,
    never_expire: user.never_expire,
    created_at: user.created_at,
    updated_at: user.updated_at,
  }
})
