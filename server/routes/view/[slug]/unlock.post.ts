import { getRouterParam, readBody, setHeader, sendRedirect } from 'h3'
import { findUploadBySlug } from '~/server/utils/db'
import { verifyPassword } from '~/server/utils/password'
import { setViewAuthCookie } from '~/server/utils/view-auth'

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')
  if (!slug) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }
  const row = await findUploadBySlug(event, slug)
  if (!row || !row.password_hash) {
    return sendRedirect(event, `/view/${slug}/`, 302)
  }
  const body = await readBody(event).catch(() => ({}))
  const password = typeof body?.password === 'string' ? body.password : ''
  if (!(await verifyPassword(password, row.password_hash))) {
    setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
    const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Unlock paste</title>
<style>*{box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#0f0f12;color:#e4e4e7;min-height:100vh;margin:0;display:flex;align-items:center;justify-content:center;padding:1.5rem}.box{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:2rem;max-width:360px}.error{color:#f87171;margin-bottom:1rem}input{width:100%;padding:0.75rem 1rem;border:1px solid rgba(255,255,255,0.15);border-radius:8px;background:rgba(255,255,255,0.06);color:#e4e4e7;font-size:1rem;margin-bottom:1rem}button{width:100%;padding:0.75rem;background:rgba(167,139,250,0.3);border:1px solid rgba(167,139,250,0.5);border-radius:8px;color:#c4b5fd;font-size:1rem;cursor:pointer}</style>
</head>
<body><div class="box"><p class="error">Wrong password. Try again.</p><form method="post" action="/view/${slug}/unlock"><input type="password" name="password" placeholder="Password" required autofocus><button type="submit">Unlock</button></form></div></body></html>`
    return html
  }
  setViewAuthCookie(event, slug)
  return sendRedirect(event, `/view/${slug}/`, 302)
})
