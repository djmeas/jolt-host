import { createError, getRequestURL, setHeader, setResponseStatus } from 'h3'
import { findUploadBySlug } from '~/server/utils/db'
import {
  getEffectiveHost,
  isAppOriginHost,
  isBlockedAppPath,
  isJoltHostedPath,
  isLoopbackHost,
  isSiteBaseHost,
  matchSiteHost,
  serveSiteContent,
} from '~/server/utils/site-host'
import { isProductionRuntime } from '~/server/utils/runtime-mode'

/**
 * Host dispatcher for the origin boundary.
 *
 * A request on a hosted site origin can only ever reach that site's own stored
 * files or Jolt's `/_jolt/...` endpoints. Uploaded HTML must never execute on
 * the application origin, so the app's pages, APIs, and assets are unreachable
 * from a site origin. Requests on the app origin cannot reach `/_jolt/...`,
 * which is served only from hosted origins.
 */
export default defineEventHandler(async (event) => {
  const pathname = getRequestURL(event).pathname
  const host = getEffectiveHost(event)
  const match = matchSiteHost(host)

  if (!match) {
    // A host under the configured site base that is not exactly `<slug>.<base>`
    // (bare base, extra labels, malformed label) is not a site: the app must
    // never run on the hosted registrable domain.
    if (isSiteBaseHost(host)) {
      throw createError({ statusCode: 404, message: 'Not found' })
    }
    // In production only the configured app origin serves the application — plus
    // loopback hosts, which no other machine can reach. Without the loopback
    // exemption a deployment with no origins configured yet (local
    // `docker compose up`, `npm run preview`) would 404 every page with no hint why.
    if (isProductionRuntime() && !isAppOriginHost(host) && !isLoopbackHost(host)) {
      throw createError({ statusCode: 404, message: 'Not found' })
    }
    if (pathname === '/_jolt' || pathname.startsWith('/_jolt/')) {
      throw createError({ statusCode: 404, message: 'Not found' })
    }
    return
  }

  setHeader(event, 'Referrer-Policy', 'no-referrer')

  // Nitro re-enters the middleware stack with its internal error route when a
  // handler throws. A site origin must never serve site content (or the app's
  // error page) for that, so answer 404 without throwing again.
  if (pathname.startsWith('/__nuxt')) {
    setResponseStatus(event, 404)
    return ''
  }

  const row = findUploadBySlug(match.slug)
  if (!row) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }
  if (row.expires_at && new Date(row.expires_at) <= new Date()) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  if (pathname === '/_jolt' || pathname.startsWith('/_jolt/')) {
    if (!isJoltHostedPath(pathname)) {
      throw createError({ statusCode: 404, message: 'Not found' })
    }
    return
  }

  if (isBlockedAppPath(pathname)) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  return await serveSiteContent(event, row, pathname)
})
