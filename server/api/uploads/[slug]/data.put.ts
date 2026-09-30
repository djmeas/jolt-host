import { getRouterParam, readBody } from 'h3'
import { disableDataBySlug, enableDataBySlug, findUploadBySlug } from '~/server/utils/db'
import { authorizeContentUpdate } from '~/server/utils/update-auth'
import { hasValidApiToken } from '~/server/utils/upload-auth'
import { getDataFeatureStatus } from '~/server/utils/data-auth'

/**
 * `PUT /api/uploads/[slug]/data` — owner/admin opt-in for a site's JSON data API.
 *
 * Enabling is refused without a password (409) and while the deployment cannot
 * host an isolated origin with signing secrets (503). Disabling always works and
 * keeps every stored record.
 */
export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')
  if (!slug) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  const row = findUploadBySlug(slug)
  if (!row) {
    throw createError({ statusCode: 404, message: 'Site not found' })
  }
  if (row.expires_at && new Date(row.expires_at) <= new Date()) {
    throw createError({ statusCode: 404, message: 'Site has expired' })
  }

  const body = await readBody(event).catch(() => ({}))
  const ownerToken = typeof body?.owner_token === 'string' ? body.owner_token.trim() : ''

  // Same site-ownership rules as replacing content: a view or data session, a
  // general upload token, or an app admin/user session is not ownership proof
  // for arbitrary sites.
  authorizeContentUpdate(event, row, ownerToken, hasValidApiToken(event))

  const enabled = body?.enabled
  if (typeof enabled !== 'boolean') {
    throw createError({ statusCode: 400, message: '"enabled" must be a boolean' })
  }

  if (!enabled) {
    if (!disableDataBySlug(slug)) {
      throw createError({ statusCode: 404, message: 'Site not found' })
    }
    return { slug, data_enabled: false }
  }

  const feature = getDataFeatureStatus()
  if (!feature.enabled) {
    throw createError({
      statusCode: 503,
      message: feature.reason ?? 'Site data is not available on this deployment',
    })
  }

  // The password and expiration predicate lives in the UPDATE itself, so a
  // password cleared while this request was in flight cannot enable data.
  if (!enableDataBySlug(slug)) {
    const current = findUploadBySlug(slug)
    if (!current || (current.expires_at && new Date(current.expires_at) <= new Date())) {
      throw createError({ statusCode: 404, message: 'Site not found' })
    }
    throw createError({
      statusCode: 409,
      message: 'Set a password before enabling the site data API',
    })
  }
  return { slug, data_enabled: true }
})
