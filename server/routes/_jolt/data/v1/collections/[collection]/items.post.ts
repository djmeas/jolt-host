import { createError, getRouterParam, setHeader, setResponseStatus } from 'h3'
import {
  DATA_BODY_MAX_BYTES,
  extractRecordValue,
  readBoundedJson,
  requireDataEnabled,
  requireDataWriteAccess,
  requireJsonContentType,
  runDataApi,
} from '~/server/utils/data-api'
import { requireSiteHostRow } from '~/server/utils/site-host'
import { checkDataRequestRate, checkDataWriteRate } from '~/server/utils/site-rate-limit'
import { COLLECTION_PATTERN, createItem, serializeRecordValue } from '~/server/utils/site-data'

/** `POST /_jolt/data/v1/collections/<collection>/items` — requires a data-admin session. */
export default defineEventHandler((event) =>
  runDataApi(event, async () => {
    setHeader(event, 'Cache-Control', 'no-store')
    const { row, origin } = requireSiteHostRow(event)
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

    const sessionKey = requireDataWriteAccess(event, row, origin)
    const writeRate = checkDataWriteRate(row.id, sessionKey)
    if (!writeRate.allowed) {
      throw createError({
        statusCode: 429,
        message: 'Too many writes',
        data: { retry_after: writeRate.retryAfter ?? 60 },
      })
    }

    requireJsonContentType(event)
    const body = await readBoundedJson(event, DATA_BODY_MAX_BYTES)
    const json = serializeRecordValue(extractRecordValue(body))

    // Reading the body is this handler's only await, so the live row, data flag,
    // and session are re-checked synchronously here: a delete, expiry, disable,
    // or password change during a slow upload cannot be raced into a write.
    const live = requireSiteHostRow(event)
    requireDataEnabled(live.row)
    requireDataWriteAccess(event, live.row, live.origin)

    const record = createItem(live.row.id, collection, json)
    setResponseStatus(event, 201)
    return record
  })
)
