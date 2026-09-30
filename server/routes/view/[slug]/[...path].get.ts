import { createError, getQuery, getRouterParam, sendRedirect } from 'h3'
import { legacyViewTarget } from '~/server/utils/site-host'

/**
 * Legacy application-origin asset link. Assets are served only from the site's
 * canonical hosted origin, so uploaded JavaScript never runs on the app origin.
 */
export default defineEventHandler((event) => {
  const slug = getRouterParam(event, 'slug')
  if (!slug) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }
  const pathParam = getRouterParam(event, 'path') ?? ''
  const query = getQuery(event)
  const unlock = typeof query.unlock === 'string' ? query.unlock : null
  const target = legacyViewTarget(slug, pathParam, unlock)
  if (!target) {
    throw createError({
      statusCode: 503,
      message: 'Hosted site origins are not configured on this server',
    })
  }
  return sendRedirect(event, target, 302)
})
