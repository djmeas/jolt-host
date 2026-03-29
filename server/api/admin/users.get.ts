import { getQuery } from 'h3'
import { requireAdmin } from '~/server/utils/admin-auth'
import { getUsersPaginated } from '~/server/utils/db'

export default defineEventHandler((event) => {
  requireAdmin(event)
  const query = getQuery(event)
  const page = Math.max(1, parseInt(String(query.page || 1), 10) || 1)
  const limit = Math.min(100, Math.max(1, parseInt(String(query.limit || 20), 10) || 20))

  const { items, total } = getUsersPaginated(page, limit)

  return {
    items,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  }
})
