import { registeredUsersOnly, registrationEnabled, dataApiToggleEnabled } from '~/server/utils/upload-mode'
import { getDataFeatureStatus } from '~/server/utils/data-auth'

export default defineEventHandler(() => {
  return {
    authEnabled: registeredUsersOnly(),
    registeredUsersOnly: registeredUsersOnly(),
    registrationEnabled: registrationEnabled(),
    landingPageEnabled: process.env.ENABLE_LANDING_PAGE !== 'false',
    dataFeatureAvailable: getDataFeatureStatus().enabled,
    dataApiToggleEnabled: dataApiToggleEnabled(),
  }
})
