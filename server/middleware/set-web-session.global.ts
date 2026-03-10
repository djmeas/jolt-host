import { setWebSessionCookie } from '~/server/utils/web-session'

/**
 * Sets a web session cookie when users visit the upload page or result page.
 * This cookie allows anonymous uploads via the web form; API uploads require an API token.
 */
export default defineEventHandler((event) => {
  const path = getRequestURL(event).pathname
  if (event.method !== 'GET') return
  if (path === '/' || path.startsWith('/result')) {
    setWebSessionCookie(event)
  }
})
