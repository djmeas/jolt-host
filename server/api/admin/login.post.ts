import { readBody } from 'h3'
import { setAdminCookie } from '~/server/utils/admin-auth'
import { useCloudflare } from '~/server/utils/cf'

export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => ({}))
  const password = typeof body?.password === 'string' ? body.password : ''
  const config = useRuntimeConfig(event)
  const cf = useCloudflare(event)
  const adminPassword =
    cf.JOLT_ADMIN_PASSWORD || config.jolthost?.adminPassword || process.env.JOLT_ADMIN_PASSWORD || ''

  if (!adminPassword) {
    throw createError({ statusCode: 500, message: 'Admin password not configured' })
  }
  if (password !== adminPassword) {
    throw createError({ statusCode: 401, message: 'Invalid password' })
  }

  setAdminCookie(event)
  return { ok: true }
})
