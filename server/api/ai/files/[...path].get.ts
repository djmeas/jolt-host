import { getRouterParam, setHeader } from 'h3'
import { getAiWorkspace } from '~/server/utils/db'
import { readWorkspaceFile } from '~/server/utils/ai-workspace'
import { aiError, requireAiConfig, requireAiUser, runAiApi } from '~/server/utils/ai-http'

/**
 * One editable text file of the committed workspace generation, returned as
 * JSON-escaped text so generated HTML/SVG/JS can never execute on the app
 * origin. Opaque assets have no bytes on this route.
 */
export default defineEventHandler((event) =>
  runAiApi(event, () => {
    setHeader(event, 'Cache-Control', 'no-store')
    setHeader(event, 'Content-Type', 'application/json; charset=utf-8')

    requireAiConfig()
    const userId = requireAiUser(event)

    const raw = getRouterParam(event, 'path') ?? ''
    let path: string
    try {
      // The router hands over the still-encoded wildcard; decode exactly once,
      // then validate. A rejected path is never normalized into another one.
      path = decodeURIComponent(raw)
    } catch {
      throw aiError(400, 'invalid_path', 'Invalid workspace file path.')
    }

    const row = getAiWorkspace(userId)
    if (!row || row.current_generation === null) {
      throw aiError(404, 'file_not_found', 'No such workspace file.')
    }
    const file = readWorkspaceFile(userId, row.current_generation, path)
    return { path: file.path, content: file.content, bytes: file.bytes, revision: row.revision }
  })
)
