import { requireAdmin } from '~/server/utils/admin-auth'
import { getAllApiTokens } from '~/server/utils/db'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const tokens = await getAllApiTokens(event)
  return { tokens }
})
