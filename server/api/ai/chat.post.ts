import { setHeader } from 'h3'
import { randomUUID } from 'crypto'
import {
  AI_CHAT_BODY_MAX_BYTES,
  aiChatCompletion,
  buildAiChatMessages,
  parseAiManifest,
  type AiCompletionFailureCode,
} from '~/server/utils/ai-builder'
import {
  finalizeAiTurnError,
  finalizeAiTurnSuccess,
  getAiConversationTurns,
  getAiWorkspace,
  getOrCreateAiWorkspace,
  insertAiTurnPending,
} from '~/server/utils/db'
import {
  describeWorkspace,
  discardPreparedGeneration,
  pruneWorkspaceGenerations,
  readEditableWorkspaceFiles,
  stageWorkspaceGeneration,
  WorkspaceError,
  type WorkspaceFiles,
} from '~/server/utils/ai-workspace'
import {
  aiError,
  requireAiConfig,
  requireAiOrigin,
  requireAiUser,
  requireAttachedTarget,
  runAiApi,
  type AiErrorCode,
} from '~/server/utils/ai-http'
import { checkAiChatRateLimit, releaseAiOperation, tryAcquireAiOperation } from '~/server/utils/ai-rate-limit'
import { readBoundedJson, requireJsonContentType } from '~/server/utils/data-api'

const INVALID_MANIFEST_MESSAGE = 'The model response was not a valid file manifest.'

/** Safe, server-authored error surface for each provider failure code. */
const FAILURE_BY_COMPLETION_CODE: Record<
  AiCompletionFailureCode,
  { statusCode: number; code: AiErrorCode; message: string; summary: string }
> = {
  ai_unavailable: {
    statusCode: 503,
    code: 'ai_unavailable',
    message: 'AI Builder is not available on this server.',
    summary: 'AI Builder was not available.',
  },
  provider_failed: {
    statusCode: 502,
    code: 'provider_failed',
    message: 'The model provider call failed.',
    summary: 'The model provider call failed.',
  },
  provider_timeout: {
    statusCode: 504,
    code: 'provider_timeout',
    message: 'The model provider call timed out.',
    summary: 'The model provider call timed out.',
  },
  provider_response_too_large: {
    statusCode: 502,
    code: 'provider_response_too_large',
    message: 'The model response was too large.',
    summary: 'The model response was too large.',
  },
}

/** `{ "message": string, "revision": integer }` and nothing else. */
function parseChatRequest(body: unknown): { message: string; revision: number } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw aiError(400, 'invalid_request', 'A JSON body with "message" and "revision" is required.')
  }
  const record = body as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 2 || !keys.includes('message') || !keys.includes('revision')) {
    throw aiError(400, 'invalid_request', 'A JSON body with exactly "message" and "revision" is required.')
  }
  const { message, revision } = record
  if (typeof message !== 'string' || message.trim() === '') {
    throw aiError(400, 'invalid_request', 'A nonblank "message" is required.')
  }
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    throw aiError(400, 'invalid_request', '"revision" must be a nonnegative integer.')
  }
  return { message, revision }
}

/**
 * One chat turn: exactly one provider call, one validated JSON file manifest,
 * one atomic workspace generation. Recorded revision and files stay untouched on
 * every failure path, and the account's attempt budget is spent before the call.
 */
export default defineEventHandler((event) =>
  runAiApi(event, async () => {
    setHeader(event, 'Cache-Control', 'no-store')
    setHeader(event, 'Content-Type', 'application/json; charset=utf-8')

    const config = requireAiConfig()
    const userId = requireAiUser(event)
    requireAiOrigin(event)
    requireJsonContentType(event)
    const input = parseChatRequest(await readBoundedJson(event, AI_CHAT_BODY_MAX_BYTES))

    if (!tryAcquireAiOperation(userId)) {
      throw aiError(409, 'workspace_busy', 'A workspace operation is already running.')
    }
    try {
      // Read before create: a stale revision or an exhausted budget must not
      // allocate a workspace row.
      const existing = getAiWorkspace(userId)
      const currentRevision = existing?.revision ?? 0
      if (input.revision !== currentRevision) {
        throw aiError(409, 'workspace_conflict', 'The workspace changed since it was loaded.')
      }
      // An attached workspace must still point at an owned, live, nonanonymous
      // upload. This is free, so it runs before any budget is spent.
      if (existing?.attached_upload_id != null) {
        requireAttachedTarget(event, userId, existing)
      }
      const rate = checkAiChatRateLimit(userId)
      if (!rate.allowed) {
        throw aiError(429, 'rate_limited', 'The chat rate limit was reached.', { retry_after: rate.retryAfter ?? 60 })
      }

      const workspace = existing ?? getOrCreateAiWorkspace(userId)
      if (!workspace) {
        throw aiError(401, 'authentication_required', 'Sign in with a registered account to use AI Builder.')
      }

      const turnId = randomUUID()
      if (!insertAiTurnPending({ turnId, userId, sessionId: workspace.session_id, userContent: input.message })) {
        throw aiError(401, 'authentication_required', 'Sign in with a registered account to use AI Builder.')
      }

      const base = describeWorkspace(userId, workspace.current_generation)
      const editableFiles = readEditableWorkspaceFiles(userId, workspace.current_generation)
      const history = getAiConversationTurns(userId, workspace.session_id).map((turn) => ({
        user: turn.userContent,
        assistant: turn.assistantContent,
      }))

      const completion = await aiChatCompletion({
        messages: buildAiChatMessages({
          revision: workspace.revision,
          entryFile: base.entryFile,
          editableFiles,
          history,
          userMessage: input.message,
        }),
      })
      if (!completion.ok) {
        const failure = FAILURE_BY_COMPLETION_CODE[completion.code]
        finalizeAiTurnError({
          turnId,
          userId,
          summary: failure.summary,
          errorCode: completion.code,
          model: null,
          inputTokens: null,
          outputTokens: null,
          durationMs: completion.durationMs,
        })
        throw aiError(failure.statusCode, failure.code, failure.message)
      }

      const model = completion.model ?? config.model
      const usage = {
        model,
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        durationMs: completion.durationMs,
      }
      const manifest = parseAiManifest(completion.content)
      if (!manifest.ok) {
        finalizeAiTurnError({
          turnId,
          userId,
          summary: 'The model response was not a usable file manifest.',
          errorCode: 'invalid_model_output',
          ...usage,
        })
        throw aiError(502, 'invalid_model_output', manifest.message)
      }

      // From here the turn has a staged generation: it must be removed on any
      // failure, and the transcript must be finalized exactly once.
      let preparedGeneration: string | null = null
      let settled = false
      const failTurn = (errorCode: string, summary: string) => {
        if (settled) return
        settled = true
        finalizeAiTurnError({ turnId, userId, summary, errorCode, ...usage })
      }

      try {
        // Account deletion can finish while the provider response is held.
        // Recheck before staging so that cleanup cannot be undone by fresh files.
        requireAiUser(event)
        let staged: WorkspaceFiles
        try {
          staged = stageWorkspaceGeneration(userId, base, manifest.operations)
        } catch (error) {
          if (error instanceof WorkspaceError && error.code !== 'workspace_storage_failed') {
            // Unsafe paths, unsupported edits, and quota overruns are invalid
            // model output, never a client mistake.
            failTurn('invalid_model_output', 'The model response could not be applied to the workspace.')
            throw aiError(502, 'invalid_model_output', INVALID_MANIFEST_MESSAGE)
          }
          failTurn('workspace_storage_failed', 'The workspace could not be written.')
          throw error
        }
        preparedGeneration = staged.generation

        let committed: boolean
        try {
          committed = finalizeAiTurnSuccess({
            turnId,
            userId,
            summary: manifest.summary,
            ...usage,
            // The pointer switch and the transcript finalization share one
            // transaction; a lost compare-and-switch leaves the old generation
            // active and reports no success.
            workspace: {
              userId,
              expectedRevision: workspace.revision,
              expectedGeneration: workspace.current_generation,
              generation: staged.generation!,
              entryFile: staged.entryFile,
            },
          })
        } catch (error) {
          failTurn('workspace_storage_failed', 'The workspace could not be committed.')
          throw error
        }
        if (!committed) {
          failTurn('workspace_conflict', 'The workspace changed before the turn could be applied.')
          throw aiError(409, 'workspace_conflict', 'The workspace changed since it was loaded.')
        }
        settled = true
        preparedGeneration = null

        const described = describeWorkspace(userId, staged.generation)
        try {
          pruneWorkspaceGenerations(userId, staged.generation, workspace.snapshot_dir)
        } catch (error) {
          // Cleanup is best effort: the committed turn must still be reported.
          console.error('[ai]', error)
        }
        return {
          turn_id: turnId,
          summary: manifest.summary,
          files: described.files.filter((file) => file.editable).map((file) => file.path),
          workspace_files: described.editableFiles,
          revision: getAiWorkspace(userId)?.revision ?? workspace.revision + 1,
          usage: {
            model,
            input_tokens: completion.inputTokens,
            output_tokens: completion.outputTokens,
            duration_ms: completion.durationMs,
          },
        }
      } finally {
        if (preparedGeneration !== null) {
          try {
            discardPreparedGeneration(userId, preparedGeneration)
          } catch (error) {
            console.error('[ai]', error)
          }
        }
      }
    } finally {
      releaseAiOperation(userId)
    }
  })
)
