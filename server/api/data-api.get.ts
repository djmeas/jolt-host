import { readFileSync } from 'fs'
import { join } from 'path'
import { marked } from 'marked'
import { createError } from 'h3'
import { isAdminAuthenticated } from '~/server/utils/admin-auth'
import { getUserIdFromEvent } from '~/server/utils/user-auth'

/**
 * `GET /api/data-api` — the site data API reference, rendered from
 * `docs/jolt-data-api.md`.
 *
 * Same shape as `/api/how-to`, `/api/privacy`, `/api/terms` (`{ html }`), so the
 * dashboard can render it with `v-html`. Unlike those public pages this one is
 * gated: it documents operator-facing details (origins, secrets, rate limits)
 * that have no business being served to anonymous visitors.
 */
export default defineEventHandler((event) => {
  if (!isAdminAuthenticated(event) && !getUserIdFromEvent(event)) {
    throw createError({ statusCode: 401, message: 'Authentication required' })
  }

  const md = readFileSync(join(process.cwd(), 'docs', 'jolt-data-api.md'), 'utf-8')
  return { html: marked.parse(md) as string }
})
