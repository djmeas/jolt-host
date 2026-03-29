import { clearUserCookie } from '~/server/utils/user-auth'

export default defineEventHandler((event) => {
  clearUserCookie(event)
  return { ok: true }
})
