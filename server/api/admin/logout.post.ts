import { clearAdminCookie } from '~/server/utils/admin-auth'

export default defineEventHandler((event) => {
  clearAdminCookie(event)
  return { ok: true }
})
