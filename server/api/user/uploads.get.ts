import { getQuery } from 'h3'
import { requireUser } from '~/server/utils/user-auth'
import { getUploadsByUserId } from '~/server/utils/db'

export default defineEventHandler((event) => {
  const userId = requireUser(event)
  const query = getQuery(event)
  const page = Math.max(1, parseInt(String(query.page || 1), 10) || 1)
  const limit = Math.min(100, Math.max(1, parseInt(String(query.limit || 20), 10) || 20))

  const { items, total } = getUploadsByUserId(userId, page, limit)

  return {
    items,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  }
})
