import { requireUser } from '~/server/utils/user-auth'
import { getApiTokensByUserId } from '~/server/utils/db'

export default defineEventHandler((event) => {
  const userId = requireUser(event)
  return { tokens: getApiTokensByUserId(userId) }
})
