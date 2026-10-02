/**
 * Shared request handling for the private `/api/ai/**` surface.
 *
 * Every AI route answers JSON and nothing else, checks availability before auth
 * or body parsing, resolves the workspace owner solely from the signed-in
 * account cookie plus a live user row, and refuses cross-origin mutations with
 * the configured application origin. Development additionally permits direct
 * loopback app origins on another port, never hosted-site subdomains.
 * Responses are never cacheable and never carry provider bodies, keys, absolute
 * paths, stack traces, or prompts.
 */

import { getRequestHeader, setHeader, setResponseStatus, createError } from 'h3'
import type { H3Event } from 'h3'
import { resolveAiConfig, type AiProviderConfig } from '~/server/utils/ai-builder'
import { DEFAULT_ENTRY_FILE, describeWorkspace, WorkspaceError, type WorkspaceFile } from '~/server/utils/ai-workspace'
import { findUploadBySlug, findUserById, type AiWorkspaceRow, type UploadRow } from '~/server/utils/db'
import { canonicalSiteUrl, getSiteHostConfig, requireExactOrigin } from '~/server/utils/site-host'
import { isAdminAuthenticated } from '~/server/utils/admin-auth'
import { isProductionRuntime } from '~/server/utils/runtime-mode'
import { getUserIdFromEvent } from '~/server/utils/user-auth'

/** Machine-readable code returned in every AI error body. */
export type AiErrorCode =
  | 'ai_unavailable'
  | 'authentication_required'
  | 'builder_disabled'
  | 'origin_mismatch'
  | 'invalid_request'
  | 'invalid_path'
  | 'request_too_large'
  | 'file_not_found'
  | 'opaque_file'
  | 'target_unavailable'
  | 'target_forbidden'
  | 'workspace_busy'
  | 'workspace_conflict'
  | 'workspace_limit_exceeded'
  | 'editable_workspace_too_large'
  | 'source_too_large'
  | 'no_edit_snapshot'
  | 'workspace_storage_failed'
  | 'empty_workspace'
  | 'attached_workspace'
  | 'data_toggle_disabled'
  | 'rate_limited'
  | 'provider_failed'
  | 'provider_timeout'
  | 'provider_response_too_large'
  | 'invalid_model_output'

/** Workspace error codes whose wire code differs from their internal name. */
const CODE_BY_WORKSPACE_CODE: Partial<Record<WorkspaceError['code'], AiErrorCode>> = {
  user_missing: 'authentication_required',
}

/**
 * Fallback codes for errors raised by the shared request helpers (body caps,
 * content type, origin, a missing file) that carry only a status.
 */
const DEFAULT_CODE_BY_STATUS: Partial<Record<number, AiErrorCode>> = {
  400: 'invalid_request',
  401: 'authentication_required',
  403: 'origin_mismatch',
  404: 'file_not_found',
  409: 'workspace_conflict',
  413: 'request_too_large',
  429: 'rate_limited',
  503: 'ai_unavailable',
}

/**
 * Builds the shared AI error: the endpoint layer turns it into
 * `{ "error": { "code", "message" } }` with the given status.
 */
export function aiError(
  statusCode: number,
  code: AiErrorCode,
  message: string,
  extra?: Record<string, unknown>
): Error {
  return createError({ statusCode, statusMessage: code, message, data: { code, ...extra } })
}

/**
 * Runs one AI handler and always answers the documented JSON error shape.
 * Errors carry no raw provider or model text: only the server-authored message.
 */
export async function runAiApi(event: H3Event, handler: () => Promise<unknown> | unknown): Promise<unknown> {
  try {
    return await handler()
  } catch (err) {
    const candidate = err as { statusCode?: number; message?: string; data?: unknown }
    const data =
      candidate?.data && typeof candidate.data === 'object' && !Array.isArray(candidate.data)
        ? (candidate.data as Record<string, unknown>)
        : {}
    let statusCode =
      typeof candidate?.statusCode === 'number' && candidate.statusCode >= 400 ? candidate.statusCode : 500
    let code: AiErrorCode =
      typeof data.code === 'string'
        ? (data.code as AiErrorCode)
        : (DEFAULT_CODE_BY_STATUS[statusCode] ??
          (statusCode >= 500 ? 'workspace_storage_failed' : 'invalid_request'))
    // Workspace helpers throw typed errors; translate the ones whose wire code
    // differs from their internal name.
    if (err instanceof WorkspaceError) {
      code = CODE_BY_WORKSPACE_CODE[err.code] ?? (err.code as AiErrorCode)
      statusCode = err.statusCode
    }
    const message =
      typeof candidate?.message === 'string' && candidate.message ? candidate.message : 'The request could not be completed.'
    if (statusCode >= 500) console.error('[ai]', err)

    const retryAfter = typeof data.retry_after === 'number' && Number.isSafeInteger(data.retry_after) ? data.retry_after : null
    if (statusCode === 429 && retryAfter !== null) setHeader(event, 'Retry-After', retryAfter)
    setHeader(event, 'Cache-Control', 'no-store')
    setHeader(event, 'Content-Type', 'application/json; charset=utf-8')
    setResponseStatus(event, statusCode)
    return retryAfter === null ? { error: { code, message } } : { error: { code, message }, retry_after: retryAfter }
  }
}

/** Availability is checked before auth and body parsing, and allocates nothing. */
export function requireAiConfig(): AiProviderConfig {
  const availability = resolveAiConfig()
  if (!availability.available) throw aiError(503, 'ai_unavailable', 'AI Builder is not available on this server.')
  return availability.config
}

/**
 * The workspace owner is derived only from the signed-in account cookie and a
 * live user row. Bearer API tokens, view cookies, owner tokens, and admin-only
 * sessions never allocate a workspace.
 */
export function requireAiUser(event: H3Event): string {
  const userId = getUserIdFromEvent(event)
  const user = userId ? findUserById(userId) : null
  if (!userId || !user) {
    throw aiError(401, 'authentication_required', 'Sign in with a registered account to use AI Builder.')
  }
  if (!user.ai_build_enabled) {
    throw aiError(403, 'builder_disabled', 'Build mode is not enabled for your account — ask an admin.')
  }
  return userId
}

/** Only direct loopback app origins are accepted in development. Never allow `.localhost` hosted sites. */
function isDevelopmentLoopbackAppOrigin(event: H3Event): boolean {
  if (isProductionRuntime()) return false
  const raw = getRequestHeader(event, 'origin')
  if (!raw) return false
  try {
    const origin = new URL(raw)
    if (origin.origin !== raw || (origin.protocol !== 'http:' && origin.protocol !== 'https:')) return false
    return origin.hostname === 'localhost' || origin.hostname === '127.0.0.1' || origin.hostname === '[::1]'
  } catch {
    return false
  }
}

/** Mutations must come from the application origin; direct loopback apps may use a different dev port. */
export function requireAiOrigin(event: H3Event): void {
  const origin = getSiteHostConfig().app?.origin
  if (!origin) throw aiError(403, 'origin_mismatch', 'The application origin is not configured.')
  try {
    requireExactOrigin(event, origin)
  } catch {
    if (isDevelopmentLoopbackAppOrigin(event)) return
    throw aiError(403, 'origin_mismatch', 'The request did not come from the application origin.')
  }
}

/** The attached site a builder operation is allowed to touch. */
export type AttachedTarget = {
  row: UploadRow
  uploadId: string
  slug: string
  /** Entry point observed when the site was attached or last builder-published. */
  baselineEntryPoint: string
}

/**
 * Whether an existing upload may be attached: it must exist, be unexpired and
 * nonanonymous, and the registered requester must own it or hold an
 * authenticated admin session. A matching owner token never qualifies.
 */
export function requireAttachableSite(event: H3Event, userId: string, slug: string): AttachedTarget {
  const row = findUploadBySlug(slug)
  if (!row || (row.expires_at && new Date(row.expires_at) <= new Date())) {
    throw aiError(404, 'target_unavailable', 'The site is no longer available.')
  }
  if (row.user_id === null) {
    throw aiError(403, 'target_forbidden', 'Anonymous owner-token sites cannot be attached.')
  }
  if (row.user_id !== userId && !isAdminAuthenticated(event)) {
    throw aiError(403, 'target_forbidden', 'You do not own this site.')
  }
  return { row, uploadId: row.id, slug, baselineEntryPoint: row.entry_point }
}

/**
 * Rechecks an attached workspace's target before a builder operation. The site
 * must still exist, be unexpired and nonanonymous, keep the immutable id
 * recorded at attach time, and the requester must still own it or hold an
 * authenticated admin session. A matching owner token never qualifies.
 */
export function requireAttachedTarget(
  event: H3Event,
  userId: string,
  workspace: AiWorkspaceRow
): AttachedTarget {
  const slug = workspace.attached_slug
  const uploadId = workspace.attached_upload_id
  const baselineEntryPoint = workspace.attached_entry_point
  if (!slug || !uploadId || !baselineEntryPoint) {
    throw aiError(409, 'workspace_conflict', 'This workspace is not attached to a site.')
  }

  const row = findUploadBySlug(slug)
  if (!row || (row.expires_at && new Date(row.expires_at) <= new Date()) || row.id !== uploadId) {
    throw aiError(404, 'target_unavailable', 'The attached site is no longer available.')
  }
  if (row.user_id === null) {
    throw aiError(403, 'target_forbidden', 'The attached site is not owned by a registered account.')
  }
  if (row.user_id !== userId && !isAdminAuthenticated(event)) {
    throw aiError(403, 'target_forbidden', 'You no longer have access to the attached site.')
  }
  return { row, uploadId, slug, baselineEntryPoint }
}

/** `{ "revision": integer }` and nothing else, as used by restore/reset. */
export function parseRevisionControlBody(body: unknown): number {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw aiError(400, 'invalid_request', 'A JSON body with "revision" is required.')
  }
  const record = body as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 1 || keys[0] !== 'revision') {
    throw aiError(400, 'invalid_request', 'A JSON body with exactly "revision" is required.')
  }
  const { revision } = record
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    throw aiError(400, 'invalid_request', '"revision" must be a nonnegative integer.')
  }
  return revision
}

/** `{ "slug": string, "revision": integer }` and nothing else. */
export function parseAttachBody(body: unknown): { slug: string; revision: number } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw aiError(400, 'invalid_request', 'A JSON body with "slug" and "revision" is required.')
  }
  const record = body as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 2 || !keys.includes('slug') || !keys.includes('revision')) {
    throw aiError(400, 'invalid_request', 'A JSON body with exactly "slug" and "revision" is required.')
  }
  const { slug, revision } = record
  if (
    typeof slug !== 'string' ||
    slug.trim() === '' ||
    slug.length > 200 ||
    /[\/\\\u0000-\u001f\u007f]/.test(slug)
  ) {
    throw aiError(400, 'invalid_request', 'A nonblank "slug" is required.')
  }
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    throw aiError(400, 'invalid_request', '"revision" must be a nonnegative integer.')
  }
  return { slug, revision }
}

/** Exact `WorkspaceState` returned by the file-listing endpoint. */
export type AiWorkspaceState = {
  revision: number
  entry_file: string
  files: WorkspaceFile[]
  editable_files: number
  editable_bytes: number
  opaque_files: number
  opaque_bytes: number
  target: { slug: string; url: string | null } | null
  restore_available: boolean
}

/**
 * Describes committed workspace state for a client. Reads never create a
 * workspace and never expose generation directories, snapshots, ownership
 * secrets, or absolute paths.
 */
export function buildWorkspaceState(userId: string, row: AiWorkspaceRow | null): AiWorkspaceState {
  const described = describeWorkspace(userId, row?.current_generation ?? null)
  return {
    revision: row?.revision ?? 0,
    entry_file: described.generation === null ? DEFAULT_ENTRY_FILE : described.entryFile,
    files: described.files,
    editable_files: described.editableFiles,
    editable_bytes: described.editableBytes,
    opaque_files: described.opaqueFiles,
    opaque_bytes: described.opaqueBytes,
    target: row?.attached_slug ? { slug: row.attached_slug, url: canonicalSiteUrl(row.attached_slug) } : null,
    restore_available: row?.snapshot_dir != null,
  }
}
