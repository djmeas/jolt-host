import { getQuery } from 'h3'
import { requireAdmin } from '~/server/utils/admin-auth'
import { getUploadsPaginated } from '~/server/utils/db'
import { canonicalSiteUrl } from '~/server/utils/site-host'

export default defineEventHandler((event) => {
  requireAdmin(event)
  const query = getQuery(event)
  const page = Math.max(1, parseInt(String(query.page || 1), 10) || 1)
  const limit = Math.min(100, Math.max(1, parseInt(String(query.limit || 20), 10) || 20))
  const dateFrom = typeof query.dateFrom === 'string' ? query.dateFrom : undefined
  const dateTo = typeof query.dateTo === 'string' ? query.dateTo : undefined
  let hasPassword: boolean | undefined
  if (query.protected === 'yes') hasPassword = true
  else if (query.protected === 'no') hasPassword = false

  const { items, total, page: p, limit: l } = getUploadsPaginated({
    dateFrom,
    dateTo,
    hasPassword,
    page,
    limit,
  })

  const now = Date.now()
  return {
    items: items.map((u) => ({
      id: u.id,
      slug: u.slug,
      entry_point: u.entry_point,
      created_at: u.created_at,
      expires_at: u.expires_at,
      has_password: u.has_password,
      title: u.title,
      data_enabled: u.data_enabled,
      url: canonicalSiteUrl(u.slug) ?? '',
      // UI guidance only: the builder still authorizes every request itself.
      ai_editable: u.user_id != null && (!u.expires_at || new Date(u.expires_at).getTime() > now),
    })),
    total,
    page: p,
    limit: l,
    totalPages: Math.ceil(total / l),
  }
})
