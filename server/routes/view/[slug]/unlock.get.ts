import { createError, getQuery, getRouterParam, sendRedirect } from 'h3'
import { legacyViewTarget, siteOriginForSlug } from '~/server/utils/site-host'

/**
 * Legacy application-origin unlock form. Passwords are accepted only on the
 * site's own hosted origin so that no view or data session is ever minted from
 * a query string, and so the form is never shared with uploaded content.
 */
export default defineEventHandler((event) => {
  const slug = getRouterParam(event, 'slug')
  if (!slug) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }
  const origin = siteOriginForSlug(slug)
  if (!origin) {
    throw createError({
      statusCode: 503,
      message: 'Hosted site origins are not configured on this server',
    })
  }

  const query = getQuery(event)
  const unlock = typeof query.unlock === 'string' ? query.unlock : ''
  if (unlock) {
    const target = legacyViewTarget(slug, '', unlock)
    if (target) return sendRedirect(event, target, 302)
  }
  return sendRedirect(event, `${origin}/_jolt/unlock`, 302)
})
