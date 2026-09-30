import { submitSitePassword } from '~/server/utils/site-unlock'
import { renderUnlockPage } from '~/server/utils/unlock-page'

/**
 * Normal site password POST. Grants the view cookie always, and the data-admin
 * cookie only when the site has data enabled (and then requires an exact Origin).
 */
export default defineEventHandler((event) =>
  submitSitePassword(event, {
    requireDataEnabled: false,
    enforceOrigin: 'when-data-enabled',
    renderError: renderUnlockPage,
  })
)
