import { createError } from 'h3'
import { runDataApi } from '~/server/utils/data-api'
import { requireSiteHostRow } from '~/server/utils/site-host'

/**
 * Unknown data-API paths answer JSON 404 on a hosted origin, so the application
 * renderer never runs there.
 */
export default defineEventHandler((event) =>
  runDataApi(event, () => {
    requireSiteHostRow(event)
    throw createError({ statusCode: 404, message: 'Not found' })
  })
)
