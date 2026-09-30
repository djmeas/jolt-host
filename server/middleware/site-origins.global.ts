import { getSiteHostConfig } from '~/server/utils/site-host'

/**
 * Publishes the live hosted-origin configuration onto the request so Nuxt can
 * serialize it into the page payload.
 *
 * The hosted origin is a runtime setting (`JOLT_SITE_BASE_ORIGIN`): an operator
 * may change it, or run a bundle that was built with a different origin. Public
 * runtime config only carries the value present when the bundle was built, so
 * the app reads the value the server is actually using for this request.
 */
export default defineEventHandler((event) => {
  const config = getSiteHostConfig()
  event.context.siteOrigins = {
    appOrigin: config.app?.origin ?? '',
    siteBaseOrigin: config.site?.origin ?? '',
  }
})
