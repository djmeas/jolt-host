import { submitSitePassword } from '~/server/utils/site-unlock'
import { renderDataLoginPage } from '~/server/utils/unlock-page'

/**
 * Data login POST. This is the only path that issues a data-admin session, and
 * it always requires an exact same-origin request.
 */
export default defineEventHandler((event) =>
  submitSitePassword(event, {
    requireDataEnabled: true,
    enforceOrigin: 'always',
    renderError: renderDataLoginPage,
  })
)
