import { getConfig } from '~/server/utils/db'

export default defineEventHandler(async (event) => {
  return {
    authEnabled: (await getConfig(event, 'auth_enabled', '0')) === '1',
  }
})
