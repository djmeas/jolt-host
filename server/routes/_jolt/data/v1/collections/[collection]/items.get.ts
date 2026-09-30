import { createError, getRouterParam, setHeader } from 'h3'
import {
  parseListParams,
  requireDataEnabled,
  requireDataReadAccess,
  runDataApi,
} from '~/server/utils/data-api'
import { requireSiteHostRow } from '~/server/utils/site-host'
import { checkDataRequestRate } from '~/server/utils/site-rate-limit'
import { COLLECTION_PATTERN, listItems } from '~/server/utils/site-data'

/**
 * `GET /_jolt/data/v1/collections/<collection>/items`
 *
 * Readable by any holder of the site view cookie (password or unlock link) or a
 * data-admin session. Never creates a database file.
 */
export default defineEventHandler((event) =>
  runDataApi(event, () => {
    setHeader(event, 'Cache-Control', 'no-store')
    const { row } = requireSiteHostRow(event)
    requireDataEnabled(row)

    const collection = getRouterParam(event, 'collection') ?? ''
    if (!COLLECTION_PATTERN.test(collection)) {
      throw createError({ statusCode: 400, message: 'Invalid collection name' })
    }

    const rate = checkDataRequestRate(row.id)
    if (!rate.allowed) {
      throw createError({
        statusCode: 429,
        message: 'Too many requests',
        data: { retry_after: rate.retryAfter ?? 60 },
      })
    }

    requireDataReadAccess(event, row)

    const { limit, offset } = parseListParams(event)
    return listItems(row.id, collection, limit, offset)
  })
)
