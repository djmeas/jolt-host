import { setHeader } from 'h3'
import { randomUUID } from 'crypto'
import { AI_CHAT_BODY_MAX_BYTES } from '~/server/utils/ai-builder'
import { compareAndSwitchAiWorkspace, getAiWorkspace } from '~/server/utils/db'
import { DEFAULT_ENTRY_FILE, pruneWorkspaceGenerations } from '~/server/utils/ai-workspace'
import {
  aiError,
  buildWorkspaceState,
  parseRevisionControlBody,
  requireAiConfig,
  requireAiOrigin,
  requireAiUser,
  runAiApi,
} from '~/server/utils/ai-http'
import { releaseAiOperation, tryAcquireAiOperation } from '~/server/utils/ai-rate-limit'
import { readBoundedJson, requireJsonContentType } from '~/server/utils/data-api'

/**
 * Reset the workspace back to new-site mode: empty files, a new session, and no
 * attachment or pre-edit snapshot. Previous transcript rows stay as cost history
 * but are excluded from the new session. This works even when the previously
 * attached site was deleted or expired, so users are never trapped, and it never
 * calls the provider or creates an upload.
 */
export default defineEventHandler((event) =>
  runAiApi(event, async () => {
    setHeader(event, 'Cache-Control', 'no-store')
    setHeader(event, 'Content-Type', 'application/json; charset=utf-8')

    requireAiConfig()
    const userId = requireAiUser(event)
    requireAiOrigin(event)
    requireJsonContentType(event)
    const revision = parseRevisionControlBody(await readBoundedJson(event, AI_CHAT_BODY_MAX_BYTES))

    if (!tryAcquireAiOperation(userId)) {
      throw aiError(409, 'workspace_busy', 'A workspace operation is already running.')
    }
    try {
      const workspace = getAiWorkspace(userId)
      if (!workspace) {
        // Nothing to discard; reads never create workspace state.
        return buildWorkspaceState(userId, null)
      }
      if (revision !== workspace.revision) {
        throw aiError(409, 'workspace_conflict', 'The workspace changed since it was loaded.')
      }

      const committed = compareAndSwitchAiWorkspace({
        userId,
        expectedRevision: workspace.revision,
        expectedGeneration: workspace.current_generation,
        generation: null,
        entryFile: DEFAULT_ENTRY_FILE,
        attachment: null,
        sessionId: randomUUID(),
      })
      if (!committed) {
        throw aiError(409, 'workspace_conflict', 'The workspace changed before it could be reset.')
      }

      try {
        // The reset is committed; remove every generation and the active snapshot.
        pruneWorkspaceGenerations(userId, null, null)
      } catch (error) {
        console.error('[ai]', error)
      }
      return buildWorkspaceState(userId, getAiWorkspace(userId))
    } finally {
      releaseAiOperation(userId)
    }
  })
)
