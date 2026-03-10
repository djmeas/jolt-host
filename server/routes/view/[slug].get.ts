import { getRouterParam, getQuery, setHeader, sendStream, sendRedirect } from 'h3'
import { join } from 'path'
import { createReadStream, existsSync } from 'fs'
import mime from 'mime-types'
import { getStorageDir, findUploadBySlug } from '~/server/utils/db'
import { isViewAuthorized, setViewAuthCookie, validateUnlockToken } from '~/server/utils/view-auth'
import { verifyPassword } from '~/server/utils/password'

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')
  if (!slug) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  const row = findUploadBySlug(slug)
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
      return sendRedirect(event, `/view/${slug}/`, 302)
    }
    if (passwordParam && verifyPassword(passwordParam, row.password_hash)) {
      setViewAuthCookie(event, slug)
      return sendRedirect(event, `/view/${slug}/`, 302)
    }
    return sendRedirect(event, `/view/${slug}/unlock`, 302)
  }

  const storage = getStorageDir()
  const filePath = join(storage, row.entry_point)
  if (!existsSync(filePath)) {
    throw createError({ statusCode: 404, message: 'File not found' })
  }

  // Redirect /view/slug → /view/slug/ so relative URLs in the HTML (e.g. assets/image.png)
  // resolve to /view/slug/assets/image.png instead of /view/assets/image.png
  const url = getRequestURL(event)
  if (!url.pathname.endsWith('/')) {
    const location = url.pathname + '/' + (url.search || '')
    setHeader(event, 'Cache-Control', 'public, max-age=60')
    return sendRedirect(event, location, 302)
  }

  const mimeType = mime.lookup(filePath) || 'text/html'
  setHeader(event, 'Content-Type', mimeType)
  return sendStream(event, createReadStream(filePath))
})
