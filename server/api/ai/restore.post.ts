import { setHeader } from 'h3'
import { AI_CHAT_BODY_MAX_BYTES } from '~/server/utils/ai-builder'
import { compareAndSwitchAiWorkspace, getAiWorkspace } from '~/server/utils/db'
import {
  discardPreparedGeneration,
  pruneWorkspaceGenerations,
  stageSnapshotRestore,
} from '~/server/utils/ai-workspace'
import {
  aiError,
  buildWorkspaceState,
  parseRevisionControlBody,
  requireAiConfig,
  requireAiOrigin,
  requireAiUser,
  requireAttachedTarget,
  runAiApi,
} from '~/server/utils/ai-http'
import { releaseAiOperation, tryAcquireAiOperation } from '~/server/utils/ai-rate-limit'
import { readBoundedJson, requireJsonContentType } from '~/server/utils/data-api'

/**
 * Restore the active edit session's pre-edit snapshot into a new local
 * generation. This is a private workspace restore, not a hosted rollback: the
 * live site is unchanged until the user explicitly publishes, and site
 * settings/expiration/records are never restored from the snapshot.
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
      if (!workspace || workspace.snapshot_dir === null) {
        throw aiError(409, 'no_edit_snapshot', 'There is no previous version to restore.')
      }
      if (revision !== workspace.revision) {
        throw aiError(409, 'workspace_conflict', 'The workspace changed since it was loaded.')
      }
      // The attached target must still be eligible; a baseline mismatch is not a
      // restore error because restoring only changes local draft bytes.
      requireAttachedTarget(event, userId, workspace)

      const prepared = stageSnapshotRestore(userId, workspace.snapshot_dir)
      let generation: string | null = prepared.generation
      try {
        const committed = compareAndSwitchAiWorkspace({
          userId,
          expectedRevision: workspace.revision,
          expectedGeneration: workspace.current_generation,
          generation: prepared.generation,
          entryFile: prepared.entryFile,
        })
        if (!committed) {
          throw aiError(409, 'workspace_conflict', 'The workspace changed before the restore could be applied.')
        }
        generation = null
      } finally {
        if (generation !== null) {
          try {
            discardPreparedGeneration(userId, generation)
          } catch (error) {
            console.error('[ai]', error)
          }
        }
      }

      try {
        pruneWorkspaceGenerations(userId, prepared.generation, workspace.snapshot_dir)
      } catch (error) {
        console.error('[ai]', error)
      }
      return buildWorkspaceState(userId, getAiWorkspace(userId))
    } finally {
      releaseAiOperation(userId)
    }
  })
)
