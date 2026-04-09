import { getRouterParam, getQuery, setHeader, sendRedirect } from 'h3'
import mime from 'mime-types'
import { useR2 } from '~/server/utils/cf'
import { findUploadBySlug } from '~/server/utils/db'
import { isViewAuthorized, setViewAuthCookie, validateUnlockToken } from '~/server/utils/view-auth'
import { verifyPassword } from '~/server/utils/password'

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')
  const pathParam = getRouterParam(event, 'path')
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
      return sendRedirect(event, `/view/${slug}/?unlock=${encodeURIComponent(unlockParam)}`, 302)
    }
    if (passwordParam && await verifyPassword(passwordParam, row.password_hash)) {
      setViewAuthCookie(event, slug)
      return sendRedirect(event, `/view/${slug}/`, 302)
    }
    return sendRedirect(event, `/view/${slug}/unlock`, 302)
  }

  const requestedPath = pathParam || ''

  // Prevent path traversal
  if (requestedPath.includes('..') || requestedPath.startsWith('/')) {
    throw createError({ statusCode: 404, message: 'File not found' })
  }

  // Resolve relative to the entry point's directory
  const entryDir = row.entry_point.substring(0, row.entry_point.lastIndexOf('/'))
  const r2Key = requestedPath ? `${entryDir}/${requestedPath}` : row.entry_point

  // Ensure the key stays within the slug's namespace
  if (!r2Key.startsWith(`${slug}/`)) {
    throw createError({ statusCode: 404, message: 'File not found' })
  }

  const bucket = useR2(event)

  // Try exact key first
  let obj = await bucket.get(r2Key)

  // If not found, try as directory with index.html
  if (!obj) {
    obj = await bucket.get(`${r2Key}/index.html`)
    if (obj) {
      setHeader(event, 'Content-Type', 'text/html')
      return obj.body
    }
    throw createError({ statusCode: 404, message: 'File not found' })
  }

  const mimeType = obj.httpMetadata?.contentType || mime.lookup(requestedPath) || 'application/octet-stream'
  setHeader(event, 'Content-Type', mimeType)
  return obj.body
})
