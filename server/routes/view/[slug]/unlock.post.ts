import { createError, getRouterParam, sendRedirect } from 'h3'
import { siteOriginForSlug } from '~/server/utils/site-host'

/**
 * Legacy application-origin password POST. Nothing is verified or set here:
 * the request is sent to the Jolt-owned form on the site's hosted origin, which
 * is the only place a password may be submitted.
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
  return sendRedirect(event, `${origin}/_jolt/unlock`, 303)
})
