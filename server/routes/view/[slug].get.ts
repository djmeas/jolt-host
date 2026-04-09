import { getRouterParam, getQuery, setHeader, sendRedirect } from 'h3'
import { useR2 } from '~/server/utils/cf'
import { findUploadBySlug } from '~/server/utils/db'
import { isViewAuthorized, setViewAuthCookie, validateUnlockToken } from '~/server/utils/view-auth'
import { verifyPassword } from '~/server/utils/password'
import { renderMarkdownPage } from '~/server/utils/markdown'

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')
  if (!slug) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  const row = await findUploadBySlug(event, slug)
  if (!row) {
    throw createError({ statusCode: 404, message: 'Paste not found' })
  }
  if (row.expires_at && new Date(row.expires_at) <= new Date()) {
    throw createError({ statusCode: 404, message: 'Paste has expired' })
  }
  if (row.password_hash && !isViewAuthorized(event, slug)) {
    const query = getQuery(event)
    const unlockParam = typeof query.unlock === 'string' ? query.unlock : ''
    const passwordParam = typeof query.password === 'string' ? query.password : ''
    if (unlockParam && validateUnlockToken(slug, unlockParam)) {
      setViewAuthCookie(event, slug)
      // Don't redirect — keep the unlock URL in the address bar so it can be bookmarked/shared
    } else if (passwordParam && await verifyPassword(passwordParam, row.password_hash)) {
      setViewAuthCookie(event, slug)
      return sendRedirect(event, `/view/${slug}/`, 302)
    }
    return sendRedirect(event, `/view/${slug}/unlock`, 302)
  }

  // Redirect /view/slug → /view/slug/ so relative URLs in the HTML resolve correctly
  const url = getRequestURL(event)
  if (!url.pathname.endsWith('/')) {
    const location = url.pathname + '/' + (url.search || '')
    setHeader(event, 'Cache-Control', 'public, max-age=60')
    return sendRedirect(event, location, 302)
  }

  const bucket = useR2(event)
  const obj = await bucket.get(row.entry_point)
  if (!obj) {
    throw createError({ statusCode: 404, message: 'File not found' })
  }

  // If the entry point is a markdown file, render it as HTML
  if (row.entry_point.endsWith('.md')) {
    const mdSource = await obj.text()
    const html = renderMarkdownPage(mdSource)
    setHeader(event, 'Content-Type', 'text/html')
    return html
  }

  setHeader(event, 'Content-Type', obj.httpMetadata?.contentType || 'text/html')
  return obj.body
})
