import { createError, getQuery, getRouterParam, sendRedirect } from 'h3'
import { legacyViewTarget } from '~/server/utils/site-host'

/**
 * Legacy application-origin link. Uploaded HTML is never served from the app
 * origin; the request is redirected to the site's canonical hosted origin.
 */
export default defineEventHandler((event) => {
  const slug = getRouterParam(event, 'slug')
  if (!slug) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }
  const query = getQuery(event)
  const unlock = typeof query.unlock === 'string' ? query.unlock : null
  const target = legacyViewTarget(slug, '', unlock)
  if (!target) {
    throw createError({
      statusCode: 503,
      message: 'Hosted site origins are not configured on this server',
    })
  }
  return sendRedirect(event, target, 302)
})
