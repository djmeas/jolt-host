import {
  readMultipartFormData,
  getRouterParam,
  setResponseHeader,
  createError,
  type MultiPartData,
} from 'h3'
import type { H3Event } from 'h3'
import { buildWorkspaceZip } from '~/server/utils/ai-workspace'
import { aiBuilderAvailable } from '~/server/utils/ai-builder'
import { getAiWorkspace, updateAiWorkspaceAttachedEntryPoint } from '~/server/utils/db'
import {
  aiError,
  requireAiOrigin,
  requireAiUser,
  requireAttachedTarget,
  runAiApi,
  type AiErrorCode,
} from '~/server/utils/ai-http'
import { releaseAiOperation, tryAcquireAiOperation } from '~/server/utils/ai-rate-limit'
import { checkUploadRateLimit, getClientIP } from '~/server/utils/rate-limit'
import {
  isUploadPublishFailure,
  replaceUploadFromContent,
  type ReplaceUploadResult,
  type UploadPublishFailure,
} from '~/server/utils/upload-publish'

/**
 * Content PUT is a thin adapter over the shared replacement helper. Its
 * ordinary multipart mode (`file` + `owner_token`) is unchanged. Builder mode is
 * the same endpoint with `ai_workspace_revision` instead of a file: the server
 * packages the signed-in owner's attached workspace, so opaque assets never
 * round-trip through the browser.
 */
const AI_REVISION_FIELD = 'ai_workspace_revision'

/** Management controls that must not accompany a builder publication. */
const BUILDER_FORBIDDEN_FIELDS = ['file', 'owner_token', 'title', 'password', 'expiration', 'enable_data'] as const

const REPLACE_CODE_BY_STATUS: Partial<Record<number, AiErrorCode>> = {
  400: 'invalid_request',
  401: 'authentication_required',
  403: 'target_forbidden',
  404: 'target_unavailable',
  409: 'workspace_conflict',
  413: 'request_too_large',
  429: 'rate_limited',
  503: 'ai_unavailable',
}

function readFormField(form: MultiPartData[], name: string): string {
  const field = form.find((part) => part.name === name && typeof part.data === 'object')
  return field?.data && Buffer.isBuffer(field.data) ? field.data.toString('utf8').trim() : ''
}

/** A builder publication keeps the replacement pipeline's status but the AI shape. */
function mapReplaceFailure(error: UploadPublishFailure): Error {
  const code =
    REPLACE_CODE_BY_STATUS[error.statusCode] ??
    (error.statusCode >= 500 ? 'workspace_storage_failed' : 'invalid_request')
  return aiError(
    error.statusCode,
    code,
    error.message || 'The builder publication could not be completed.',
    error.retryAfter !== undefined ? { retry_after: error.retryAfter } : undefined
  )
}

/**
 * Publishes the authenticated owner's attached workspace to that same upload.
 * It re-derives the target and its attach-time baseline from the workspace row,
 * never from client fields, and lets the replacement helper's conditional DB
 * switch reject an intervening edit.
 */
async function publishAttachedWorkspace(
  event: H3Event,
  slug: string,
  form: MultiPartData[],
  revisionRaw: string
): Promise<ReplaceUploadResult> {
  if (!aiBuilderAvailable()) {
    throw aiError(503, 'ai_unavailable', 'AI Builder is not available on this server.')
  }
  const userId = requireAiUser(event)
  requireAiOrigin(event)

  if (!/^\d+$/.test(revisionRaw)) {
    throw aiError(400, 'invalid_request', '"ai_workspace_revision" must be a nonnegative integer.')
  }
  const revision = Number(revisionRaw)
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw aiError(400, 'invalid_request', '"ai_workspace_revision" must be a nonnegative integer.')
  }
  for (const field of BUILDER_FORBIDDEN_FIELDS) {
    if (form.some((part) => part.name === field)) {
      throw aiError(400, 'invalid_request', `"${field}" is not accepted when publishing builder changes.`)
    }
  }
  const turnstileToken = readFormField(form, 'cf-turnstile-response')

  if (!tryAcquireAiOperation(userId)) {
    throw aiError(409, 'workspace_busy', 'A workspace operation is already running.')
  }
  try {
    const workspace = getAiWorkspace(userId)
    if (!workspace || workspace.attached_slug !== slug) {
      throw aiError(409, 'workspace_conflict', 'This workspace is not attached to that site. Attach it again.')
    }
    if (revision !== workspace.revision) {
      throw aiError(409, 'workspace_conflict', 'The workspace changed since it was loaded.')
    }

    const target = requireAttachedTarget(event, userId, workspace)
    if (target.row.entry_point !== target.baselineEntryPoint) {
      throw aiError(
        409,
        'workspace_conflict',
        'The live site changed since it was attached. Attach it again before publishing.'
      )
    }
    if (workspace.current_generation === null) {
      throw aiError(409, 'empty_workspace', 'The workspace has no files to publish.')
    }

    const zip = await buildWorkspaceZip(userId, workspace.current_generation)
    const preferredEntryFile = target.baselineEntryPoint.slice(target.baselineEntryPoint.lastIndexOf('/') + 1)

    let result: ReplaceUploadResult
    try {
      result = await replaceUploadFromContent(event, {
        slug,
        data: zip,
        filename: 'ai-site.zip',
        turnstileToken,
        expectedEntryPoint: target.baselineEntryPoint,
        expectedUploadId: target.uploadId,
        preferredEntryFile,
      })
    } catch (error) {
      if (!isUploadPublishFailure(error)) throw error
      throw mapReplaceFailure(error)
    }

    // Refresh only the baseline. A failure here leaves the just-published site
    // and the workspace intact; the next publication then reports 409 and the UI
    // offers an explicit reattach instead of overwriting newer content.
    if (!updateAiWorkspaceAttachedEntryPoint(userId, target.uploadId, result.entry_point)) {
      console.error('[ai] attached baseline was not refreshed for', slug)
    }
    return result
  } finally {
    releaseAiOperation(userId)
  }
}

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')
  if (!slug) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  // The upload rate limit runs before any body is buffered, so a rate-limited
  // request never reads a file. Builder mode applies the same limit exactly once.
  const ip = getClientIP(event)
  const { allowed, retryAfter } = checkUploadRateLimit(ip)
  if (!allowed) {
    if (retryAfter) {
      setResponseHeader(event, 'Retry-After', String(retryAfter))
    }
    throw createError({
      statusCode: 429,
      statusMessage: 'Too Many Requests',
      message: `Rate limit exceeded. Try again in ${retryAfter ?? 60} seconds.`,
    })
  }

  const form = await readMultipartFormData(event)
  if (!form || form.length === 0) {
    throw createError({ statusCode: 400, message: 'No file in request' })
  }

  const revisionField = readFormField(form, AI_REVISION_FIELD)
  if (revisionField !== '') {
    return await runAiApi(event, () => publishAttachedWorkspace(event, slug, form, revisionField))
  }

  const file = form.find((part) => part.name === 'file' && typeof part.data === 'object')
  const data = file?.data ? (Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data as ArrayBuffer)) : null
  return await replaceUploadFromContent(event, {
    slug,
    data,
    filename: file?.filename || 'file',
    ownerToken: readFormField(form, 'owner_token'),
    turnstileToken: readFormField(form, 'cf-turnstile-response'),
  })
})
