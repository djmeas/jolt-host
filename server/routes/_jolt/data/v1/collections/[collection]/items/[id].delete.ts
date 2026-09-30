import { createError, getRouterParam, setHeader, setResponseStatus } from 'h3'
import { requireDataEnabled, requireDataWriteAccess, runDataApi } from '~/server/utils/data-api'
import { requireSiteHostRow } from '~/server/utils/site-host'
import { checkDataRequestRate, checkDataWriteRate } from '~/server/utils/site-rate-limit'
import { COLLECTION_PATTERN, deleteItem } from '~/server/utils/site-data'

/** `DELETE /_jolt/data/v1/collections/<collection>/items/<id>` — requires a data-admin session. */
export default defineEventHandler((event) =>
  runDataApi(event, () => {
    setHeader(event, 'Cache-Control', 'no-store')
    const { row, origin } = requireSiteHostRow(event)
    requireDataEnabled(row)

    const collection = getRouterParam(event, 'collection') ?? ''
    if (!COLLECTION_PATTERN.test(collection)) {
      throw createError({ statusCode: 400, message: 'Invalid collection name' })
    }
    const itemId = getRouterParam(event, 'id') ?? ''
    if (!itemId) {
      throw createError({ statusCode: 400, message: 'Invalid record id' })
    }

    const rate = checkDataRequestRate(row.id)
    if (!rate.allowed) {
      throw createError({
        statusCode: 429,
        message: 'Too many requests',
        data: { retry_after: rate.retryAfter ?? 60 },
      })
    }

    const sessionKey = requireDataWriteAccess(event, row, origin)
    const writeRate = checkDataWriteRate(row.id, sessionKey)
    if (!writeRate.allowed) {
      throw createError({
        statusCode: 429,
        message: 'Too many writes',
        data: { retry_after: writeRate.retryAfter ?? 60 },
      })
    }

    // No await has run in this handler, so this re-check and the delete below
    // cannot be interleaved with a concurrent delete/disable/password change.
    const live = requireSiteHostRow(event)
    requireDataEnabled(live.row)
    requireDataWriteAccess(event, live.row, live.origin)

    if (!deleteItem(live.row.id, collection, itemId)) {
      throw createError({ statusCode: 404, message: 'Record not found' })
    }
    setResponseStatus(event, 204)
    return ''
  })
)
