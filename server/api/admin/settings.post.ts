import { readBody } from 'h3'
import { requireAdmin } from '~/server/utils/admin-auth'
import { setConfig } from '~/server/utils/db'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const body = await readBody(event).catch(() => ({}))
  if (typeof body?.authEnabled === 'boolean') {
    await setConfig(event, 'auth_enabled', body.authEnabled ? '1' : '0')
  }
  return { ok: true }
})
