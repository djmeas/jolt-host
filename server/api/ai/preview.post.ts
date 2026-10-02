import { setHeader } from 'h3'
import { AI_CHAT_BODY_MAX_BYTES } from '~/server/utils/ai-builder'
import { getAiWorkspace } from '~/server/utils/db'
import { buildWorkspaceZip } from '~/server/utils/ai-workspace'
import { createUploadFromContent, isUploadPublishFailure, type UploadResult } from '~/server/utils/upload-publish'
import {
  aiError,
  requireAiConfig,
  requireAiOrigin,
  requireAiUser,
  runAiApi,
  type AiErrorCode,
} from '~/server/utils/ai-http'
import { releaseAiOperation, tryAcquireAiOperation } from '~/server/utils/ai-rate-limit'
import { readBoundedJson, requireJsonContentType } from '~/server/utils/data-api'

/** The archive name the shared creation helper receives for a preview. */
const PREVIEW_FILENAME = 'ai-site.zip'

/** Body keys the JSON adapter accepts and nothing else. */
const PREVIEW_FIELDS: Record<string, true> = {
  revision: true,
  title: true,
  expiration: true,
  password: true,
  enable_data: true,
  'cf-turnstile-response': true,
}

/**
 * Preview publication reuses the ordinary upload policy, so a creation-policy
 * failure keeps its status but is reported in the shared AI error shape.
 */
const PREVIEW_CODE_BY_STATUS: Partial<Record<number, AiErrorCode>> = {
  400: 'invalid_request',
  401: 'authentication_required',
  403: 'data_toggle_disabled',
  413: 'request_too_large',
  429: 'rate_limited',
  503: 'ai_unavailable',
}

type PreviewRequest = {
  revision: number
  title: string
  expiration: string
  password: string
  enableData: boolean
  turnstileToken: string | undefined
}

/** `revision` plus the optional creation options, with no unknown fields. */
function parsePreviewRequest(body: unknown): PreviewRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw aiError(400, 'invalid_request', 'A JSON body with the preview options is required.')
  }

  const fields: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (PREVIEW_FIELDS[key] !== true) throw aiError(400, 'invalid_request', `Unknown field "${key}" is not allowed.`)
    fields[key] = value
  }

  const stringField = (name: string, fallback: string): string => {
    const value = fields[name]
    if (value === undefined) return fallback
    if (typeof value !== 'string') throw aiError(400, 'invalid_request', `"${name}" must be a string.`)
    return value
  }

  const revision = fields.revision
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    throw aiError(400, 'invalid_request', '"revision" must be a nonnegative integer.')
  }

  const enableData = fields.enable_data
  if (enableData !== undefined && typeof enableData !== 'boolean') {
    throw aiError(400, 'invalid_request', '"enable_data" must be a boolean.')
  }

  const turnstileToken = fields['cf-turnstile-response']
  if (turnstileToken !== undefined && typeof turnstileToken !== 'string') {
    throw aiError(400, 'invalid_request', '"cf-turnstile-response" must be a string.')
  }

  return {
    revision,
    title: stringField('title', ''),
    expiration: stringField('expiration', '1h'),
    password: stringField('password', ''),
    enableData: enableData === true,
    turnstileToken,
  }
}

/**
 * Publishes the committed workspace as a new real upload. This is new-mode
 * only: the archive contains exactly the editable text files, and the bytes go
 * through the same creation helper as `/api/upload` rather than a second policy.
 */
export default defineEventHandler((event) =>
  runAiApi(event, async () => {
    setHeader(event, 'Cache-Control', 'no-store')
    setHeader(event, 'Content-Type', 'application/json; charset=utf-8')

    requireAiConfig()
    const userId = requireAiUser(event)
    requireAiOrigin(event)
    requireJsonContentType(event)
    const input = parsePreviewRequest(await readBoundedJson(event, AI_CHAT_BODY_MAX_BYTES))

    if (!tryAcquireAiOperation(userId)) {
      throw aiError(409, 'workspace_busy', 'A workspace operation is already running.')
    }
    try {
      const workspace = getAiWorkspace(userId)
      if (workspace?.attached_upload_id != null) {
        throw aiError(
          409,
          'attached_workspace',
          'This workspace is attached to an existing site. Publish changes to that site instead.'
        )
      }
      if (input.revision !== (workspace?.revision ?? 0)) {
        throw aiError(409, 'workspace_conflict', 'The workspace changed since it was loaded.')
      }
      if (!workspace || workspace.current_generation === null) {
        throw aiError(409, 'empty_workspace', 'The workspace has no files to preview yet.')
      }

      const zip = await buildWorkspaceZip(userId, workspace.current_generation)

      let result: UploadResult
      try {
        result = await createUploadFromContent(event, {
          data: zip,
          filename: PREVIEW_FILENAME,
          title: input.title,
          password: input.password,
          expiration: input.expiration,
          enableData: input.enableData,
          turnstileToken: input.turnstileToken,
        })
      } catch (error) {
        if (!isUploadPublishFailure(error)) throw error
        const code =
          PREVIEW_CODE_BY_STATUS[error.statusCode] ??
          (error.statusCode >= 500 ? 'workspace_storage_failed' : 'invalid_request')
        throw aiError(
          error.statusCode,
          code,
          error.message || 'The preview could not be published.',
          error.retryAfter !== undefined ? { retry_after: error.retryAfter } : undefined
        )
      }
      return result
    } finally {
      releaseAiOperation(userId)
    }
  })
)
