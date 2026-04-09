import { requireAdmin } from '~/server/utils/admin-auth'
import { getConfig } from '~/server/utils/db'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  return {
    authEnabled: (await getConfig(event, 'auth_enabled', '0')) === '1',
  }
})
