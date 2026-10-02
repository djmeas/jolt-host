import { createError, readBody, setHeader } from 'h3'
import { requireAdmin } from '~/server/utils/admin-auth'
import { getAdminAiSettings, resolveAiChatUrl, updateAiSettings } from '~/server/utils/ai-settings'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  setHeader(event, 'Cache-Control', 'no-store')
  const body = await readBody(event).catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid_request', message: 'Settings must be an object.', data: { code: 'invalid_request' } })
  }
  for (const field of ['base_url', 'api_key', 'model']) {
    if (body[field] != null && typeof body[field] !== 'string') {
      throw createError({ statusCode: 400, statusMessage: 'invalid_request', message: 'Settings fields must be strings or null.', data: { code: 'invalid_request' } })
    }
  }
  if (typeof body.base_url === 'string' && body.base_url !== '' && !resolveAiChatUrl(body.base_url.trim())) {
    throw createError({ statusCode: 400, statusMessage: 'invalid_request', message: 'Use an absolute HTTPS base URL (HTTP is allowed only on loopback), without credentials, query, or fragment.', data: { code: 'invalid_request' } })
  }
  if (typeof body.model === 'string' && body.model !== '' && (!body.model.trim() || body.model.trim().length > 200)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid_request', message: 'Model must be nonblank and at most 200 characters.', data: { code: 'invalid_request' } })
  }
  updateAiSettings(body)
  return getAdminAiSettings()
})
