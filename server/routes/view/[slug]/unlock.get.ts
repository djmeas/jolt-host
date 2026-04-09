import { getRouterParam, getQuery, setHeader, sendRedirect } from 'h3'
import { findUploadBySlug } from '~/server/utils/db'
import { isViewAuthorized, setViewAuthCookie, validateUnlockToken } from '~/server/utils/view-auth'
import { verifyPassword } from '~/server/utils/password'

const UNLOCK_HTML = (slug: string, error?: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Unlock paste</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; background: #0f0f12; color: #e4e4e7; min-height: 100vh; margin: 0; display: flex; align-items: center; justify-content: center; padding: 1.5rem; }
    .box { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; padding: 2rem; width: 100%; max-width: 360px; }
    h1 { margin: 0 0 1rem; font-size: 1.25rem; font-weight: 600; }
    p { margin: 0 0 1rem; font-size: 0.9rem; color: #a1a1aa; }
    input { width: 100%; padding: 0.75rem 1rem; border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; background: rgba(255,255,255,0.06); color: #e4e4e7; font-size: 1rem; margin-bottom: 1rem; }
    input:focus { outline: none; border-color: #a78bfa; }
    button { width: 100%; padding: 0.75rem; background: rgba(167,139,250,0.3); border: 1px solid rgba(167,139,250,0.5); border-radius: 8px; color: #c4b5fd; font-size: 1rem; cursor: pointer; font-weight: 500; }
    button:hover { background: rgba(167,139,250,0.4); }
    .error { color: #f87171; font-size: 0.875rem; margin-bottom: 1rem; }
  </style>
</head>
<body>
  <div class="box">
    <h1>This paste is protected</h1>
    <p>Enter the password to view it.</p>
    ${error ? `<p class="error">${error}</p>` : ''}
    <form method="post" action="/view/${slug}/unlock">
      <input type="password" name="password" placeholder="Password" required autofocus autocomplete="current-password">
      <button type="submit">Unlock</button>
    </form>
  </div>
</body>
</html>`

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')
  if (!slug) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }
  const row = await findUploadBySlug(event, slug)
  if (!row || !row.password_hash) {
    return sendRedirect(event, `/view/${slug}/`, 302)
  }
  if (isViewAuthorized(event, slug)) {
    return sendRedirect(event, `/view/${slug}/`, 302)
  }
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
  setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
  return UNLOCK_HTML(slug)
})
