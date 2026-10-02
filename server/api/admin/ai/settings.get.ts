import { setHeader } from 'h3'
import { requireAdmin } from '~/server/utils/admin-auth'
import { getAdminAiSettings } from '~/server/utils/ai-settings'

export default defineEventHandler((event) => {
  requireAdmin(event)
  setHeader(event, 'Cache-Control', 'no-store')
  return getAdminAiSettings()
})
