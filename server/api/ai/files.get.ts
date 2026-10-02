import { setHeader } from 'h3'
import { getAiMessages, getAiWorkspace } from '~/server/utils/db'
import { buildWorkspaceState, requireAiConfig, requireAiUser, runAiApi } from '~/server/utils/ai-http'

/**
 * Committed workspace state plus the newest transcript rows of the current
 * session. Reads never create a workspace, a generation, or a chat record, and
 * always answer `no-store`.
 */
export default defineEventHandler((event) =>
  runAiApi(event, () => {
    setHeader(event, 'Cache-Control', 'no-store')
    setHeader(event, 'Content-Type', 'application/json; charset=utf-8')

    requireAiConfig()
    const userId = requireAiUser(event)

    const row = getAiWorkspace(userId)
    const state = buildWorkspaceState(userId, row)
    const messages = row ? getAiMessages(userId, row.session_id, 20) : []

    return {
      ...state,
      messages: messages.map((message) => ({
        id: message.id,
        turn_id: message.turn_id,
        role: message.role,
        content: message.content,
        status: message.status,
        created_at: message.created_at,
      })),
    }
  })
)
