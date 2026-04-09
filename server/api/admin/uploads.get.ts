import { getQuery } from 'h3'
import { requireAdmin } from '~/server/utils/admin-auth'
import { getUploadsPaginated } from '~/server/utils/db'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const query = getQuery(event)
  const page = Math.max(1, parseInt(String(query.page || 1), 10) || 1)
  const limit = Math.min(100, Math.max(1, parseInt(String(query.limit || 20), 10) || 20))
  const dateFrom = typeof query.dateFrom === 'string' ? query.dateFrom : undefined
  const dateTo = typeof query.dateTo === 'string' ? query.dateTo : undefined
  let hasPassword: boolean | undefined
  if (query.protected === 'yes') hasPassword = true
  else if (query.protected === 'no') hasPassword = false

  const { items, total, page: p, limit: l } = await getUploadsPaginated(event, {
    dateFrom,
    dateTo,
    hasPassword,
    page,
    limit,
  })

  const baseUrl = getRequestURL(event).origin
  return {
    items: items.map((u) => ({
      ...u,
      url: `${baseUrl}/view/${u.slug}`,
    })),
    total,
    page: p,
    limit: l,
    totalPages: Math.ceil(total / l),
  }
})
