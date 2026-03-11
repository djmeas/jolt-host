import { getRouterParam, getQuery, setHeader, sendStream, sendRedirect } from 'h3'
import path from 'path'
import { createReadStream, existsSync, statSync } from 'fs'
import mime from 'mime-types'
import { getStorageDir, findUploadBySlug } from '~/server/utils/db'
import { isViewAuthorized, setViewAuthCookie, validateUnlockToken } from '~/server/utils/view-auth'
import { verifyPassword } from '~/server/utils/password'

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')
  const pathParam = getRouterParam(event, 'path')
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
      return sendRedirect(event, `/view/${slug}/?unlock=${encodeURIComponent(unlockParam)}`, 302)
    }
    if (passwordParam && verifyPassword(passwordParam, row.password_hash)) {
      setViewAuthCookie(event, slug)
      return sendRedirect(event, `/view/${slug}/`, 302)
    }
    return sendRedirect(event, `/view/${slug}/unlock`, 302)
  }

  const storage = getStorageDir()
  const baseDir = path.resolve(storage, path.dirname(row.entry_point))
  const requestedPath = pathParam || ''
  const filePath = path.resolve(baseDir, requestedPath)

  if (!filePath.startsWith(baseDir) || !existsSync(filePath)) {
    throw createError({ statusCode: 404, message: 'File not found' })
  }

  if (statSync(filePath).isDirectory()) {
    const indexInDir = path.join(filePath, 'index.html')
    if (existsSync(indexInDir)) {
      setHeader(event, 'Content-Type', 'text/html')
      return sendStream(event, createReadStream(indexInDir))
    }
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  const mimeType = mime.lookup(filePath) || 'application/octet-stream'
  setHeader(event, 'Content-Type', mimeType)
  return sendStream(event, createReadStream(filePath))
})
