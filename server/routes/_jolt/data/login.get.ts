import { createError, setHeader } from 'h3'
import { requireSiteHostRow } from '~/server/utils/site-host'
import { renderDataLoginPage } from '~/server/utils/unlock-page'

/**
 * Jolt-owned data login form. Shown even to visitors who already have view
 * access, because holding the unlock link is not the same as holding the
 * password.
 */
export default defineEventHandler((event) => {
  const { row } = requireSiteHostRow(event)
  setHeader(event, 'Cache-Control', 'no-store')
  if (!row.data_enabled) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }
  setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
  return renderDataLoginPage()
})
