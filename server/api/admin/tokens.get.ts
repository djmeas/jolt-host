import { requireAdmin } from '~/server/utils/admin-auth'
import { getAllApiTokens } from '~/server/utils/db'

export default defineEventHandler((event) => {
  requireAdmin(event)
  const tokens = getAllApiTokens()
  return { tokens }
})
