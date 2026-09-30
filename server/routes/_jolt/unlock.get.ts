import { sendRedirect, setHeader } from 'h3'
import { requireSiteHostRow } from '~/server/utils/site-host'
import { isViewAuthorized } from '~/server/utils/view-auth'
import { renderUnlockPage } from '~/server/utils/unlock-page'

/** Jolt-owned view unlock form, served only on a site's hosted origin. */
export default defineEventHandler((event) => {
  const { row } = requireSiteHostRow(event)
  setHeader(event, 'Cache-Control', 'no-store')

  if (!row.password_hash) {
    return sendRedirect(event, '/', 302)
  }
  if (isViewAuthorized(event, row.slug)) {
    return sendRedirect(event, '/', 302)
  }

  setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
  return renderUnlockPage()
})
