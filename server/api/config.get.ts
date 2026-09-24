import { registeredUsersOnly, registrationEnabled } from '~/server/utils/upload-mode'

export default defineEventHandler(() => {
  return {
    authEnabled: registeredUsersOnly(),
    registeredUsersOnly: registeredUsersOnly(),
    registrationEnabled: registrationEnabled(),
    landingPageEnabled: process.env.ENABLE_LANDING_PAGE !== 'false',
  }
})
