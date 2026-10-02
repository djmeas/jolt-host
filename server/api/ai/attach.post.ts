import { setHeader } from 'h3'
import { randomUUID } from 'crypto'
import { AI_CHAT_BODY_MAX_BYTES } from '~/server/utils/ai-builder'
import {
  compareAndSwitchAiWorkspace,
  getAiWorkspace,
  getOrCreateAiWorkspace,
} from '~/server/utils/db'
import {
  assertAttachableSource,
  attachWorkspaceGeneration,
  discardPreparedGeneration,
  discardSnapshot,
  pruneWorkspaceGenerations,
  readServedSiteFiles,
  WorkspaceError,
  writePreEditSnapshot,
  type ServedSiteSource,
} from '~/server/utils/ai-workspace'
import {
  aiError,
  buildWorkspaceState,
  parseAttachBody,
  requireAiConfig,
  requireAiOrigin,
  requireAiUser,
  requireAttachableSite,
  runAiApi,
} from '~/server/utils/ai-http'
import { releaseAiOperation, tryAcquireAiOperation } from '~/server/utils/ai-rate-limit'
import { readBoundedJson, requireJsonContentType } from '~/server/utils/data-api'

/**
 * Attach an owned existing upload to the signed-in account's workspace. The
 * whole source is validated and copied — editable text plus opaque assets — into
 * one new generation and one pre-edit snapshot before the workspace pointer
 * switches, so a failed attach leaves the previous workspace untouched. No model
 * call and no upload row are created.
 */
export default defineEventHandler((event) =>
  runAiApi(event, async () => {
    setHeader(event, 'Cache-Control', 'no-store')
    setHeader(event, 'Content-Type', 'application/json; charset=utf-8')

    requireAiConfig()
    const userId = requireAiUser(event)
    requireAiOrigin(event)
    requireJsonContentType(event)
    const input = parseAttachBody(await readBoundedJson(event, AI_CHAT_BODY_MAX_BYTES))

    if (!tryAcquireAiOperation(userId)) {
      throw aiError(409, 'workspace_busy', 'A workspace operation is already running.')
    }
    try {
      // Eligibility and the live served root are read before any workspace state
      // is created, so a forbidden or unreadable source changes nothing.
      const target = requireAttachableSite(event, userId, input.slug)
      const observed = {
        id: target.row.id,
        entryPoint: target.row.entry_point,
        userId: target.row.user_id,
      }

      let source: ServedSiteSource
      try {
        source = readServedSiteFiles(observed.entryPoint)
        assertAttachableSource(source.entries, source.entryFile)
      } catch (error) {
        if (error instanceof WorkspaceError && error.code === 'invalid_manifest') {
          // An unusable source layout is a client-visible 400, not model output.
          throw aiError(400, 'invalid_path', error.message)
        }
        throw error
      }

      const existing = getAiWorkspace(userId)
      if (input.revision !== (existing?.revision ?? 0)) {
        throw aiError(409, 'workspace_conflict', 'The workspace changed since it was loaded.')
      }
      const workspace = existing ?? getOrCreateAiWorkspace(userId)
      if (!workspace) {
        throw aiError(401, 'authentication_required', 'Sign in with a registered account to use AI Builder.')
      }

      // The source pointer must not have moved while it was being read: never
      // seed a mixture of two published generations.
      const rechecked = requireAttachableSite(event, userId, input.slug)
      if (
        rechecked.row.id !== observed.id ||
        rechecked.row.entry_point !== observed.entryPoint ||
        rechecked.row.user_id !== observed.userId
      ) {
        throw aiError(409, 'workspace_conflict', 'The site changed while it was being attached. Try again.')
      }

      const prepared = attachWorkspaceGeneration(userId, source.entries, source.entryFile)
      let generation: string | null = prepared.generation
      let snapshot: string | null = null
      let committedSnapshot: string | null = null
      try {
        snapshot = writePreEditSnapshot(userId, source.entries, source.entryFile)
        const committed = compareAndSwitchAiWorkspace({
          userId,
          expectedRevision: workspace.revision,
          expectedGeneration: workspace.current_generation,
          generation: prepared.generation,
          entryFile: prepared.entryFile,
          attachment: {
            uploadId: observed.id,
            slug: input.slug,
            entryPoint: observed.entryPoint,
            snapshotDir: snapshot,
          },
          sessionId: randomUUID(),
        })
        if (!committed) {
          throw aiError(409, 'workspace_conflict', 'The workspace changed while the site was being attached.')
        }
        generation = null
        committedSnapshot = snapshot
        snapshot = null
      } finally {
        if (generation !== null) {
          try {
            discardPreparedGeneration(userId, generation)
          } catch (error) {
            console.error('[ai]', error)
          }
        }
        if (snapshot !== null) {
          try {
            discardSnapshot(userId, snapshot)
          } catch (error) {
            console.error('[ai]', error)
          }
        }
      }

      try {
        // The new attachment is committed; only obsolete local state is removed.
        pruneWorkspaceGenerations(userId, prepared.generation, committedSnapshot)
      } catch (error) {
        console.error('[ai]', error)
      }
      return buildWorkspaceState(userId, getAiWorkspace(userId))
    } finally {
      releaseAiOperation(userId)
    }
  })
)
