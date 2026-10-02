import type { Ref } from 'vue'
import type { UploadResult } from './useResultStorage'

/**
 * Client state for the AI Builder workspace ("Builder Studio").
 *
 * The workspace is private: replies, summaries, and file contents are rendered
 * with Vue interpolation only (never `v-html`), and file text is fetched as JSON
 * rather than rendered on this origin. Publishing happens through
 * `POST /api/ai/preview`, which creates a real owned upload; this composable
 * saves the creation result for the caller and never navigates.
 *
 * Every request URL, method, body, and error mapping mirrors the previous
 * in-component implementation; the server stays the source of truth for
 * revisions, ownership, capacity, and publication.
 */

export type WorkspaceFile = { path: string; bytes: number; editable: boolean }
export type TranscriptMessage = {
  id: string
  turn_id: string
  role: 'user' | 'assistant'
  content: string
  status: string
  created_at: string
}
export type WorkspaceTarget = { slug: string; url: string | null }
export type WorkspaceState = {
  revision: number
  entry_file: string
  files: WorkspaceFile[]
  editable_files: number
  editable_bytes: number
  opaque_files: number
  opaque_bytes: number
  target: WorkspaceTarget | null
  restore_available: boolean
  messages: TranscriptMessage[]
}
export type ChatResponse = {
  turn_id: string
  summary: string
  files: string[]
  workspace_files: number
  revision: number
}

/** Leaves room for the JSON envelope inside the server's 8 KiB body cap. */
export const CHAT_MESSAGE_MAX_BYTES = 7800

/** UTF-8 byte length of a composer draft, matching the server's byte cap. */
export function countMessageBytes(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * The server always answers failures as `{ error: { code, message } }` (plus a
 * top-level `retry_after` for 429). Provider bodies and keys never reach here.
 */
export type AiErrorInfo = { code: string | null; message: string; retryAfter: number | null }

export function readAiError(e: unknown): AiErrorInfo {
  const err = e as {
    statusCode?: number
    status?: number
    data?: { error?: { code?: unknown; message?: unknown }; retry_after?: unknown }
    message?: unknown
  }
  const body = err?.data
  const code = typeof body?.error?.code === 'string' ? body.error.code : null
  const serverMessage = typeof body?.error?.message === 'string' ? body.error.message : null
  const retryAfter =
    typeof body?.retry_after === 'number' && Number.isFinite(body.retry_after) ? body.retry_after : null
  const fallback = typeof err?.message === 'string' && err.message ? err.message : 'Something went wrong.'
  return { code, message: serverMessage ?? fallback, retryAfter }
}

/** Actionable wording for every documented AI error code. */
export const FRIENDLY_ERRORS: Record<string, string> = {
  ai_unavailable: 'AI Builder is not available on this server.',
  authentication_required: 'Sign in with a registered account to use AI Builder.',
  builder_disabled: 'Build mode is not enabled for your account — ask an admin.',
  origin_mismatch: 'That request was blocked because it did not come from this site. Reload and try again.',
  invalid_request: 'The request was rejected. Check your input and try again.',
  invalid_path: 'That file path is not valid.',
  request_too_large: 'That request was too large. Shorten it and try again.',
  file_not_found: 'That file no longer exists. Refresh the file list.',
  opaque_file: 'That file is a preserved asset and cannot be viewed as text.',
  workspace_busy: 'Another builder request is already running. Wait for it to finish, then refresh the workspace.',
  workspace_conflict: 'The workspace changed since this tab loaded. Refresh the workspace, then try again.',
  workspace_limit_exceeded: 'The workspace has reached its 50-file / 5 MiB text limit.',
  workspace_storage_failed: 'The workspace could not be saved. Try again.',
  empty_workspace: 'Generate some files with a message before previewing.',
  attached_workspace: 'This workspace is attached to an existing site, so Preview is unavailable.',
  data_toggle_disabled: 'Data API opt-in is disabled on this server.',
  rate_limited: 'You have reached the AI Builder request limit.',
  provider_failed: 'The model provider call failed. Try again.',
  provider_timeout: 'The model provider timed out. Try again.',
  provider_response_too_large: 'The model response was too large. Try a smaller request.',
  invalid_model_output: 'The model returned something that could not be applied. Rephrase your message and try again.',
  target_unavailable: 'The attached site is no longer available.',
  target_forbidden: 'You no longer have access to the attached site.',
}

export function describeAiError(info: AiErrorInfo): string {
  const base = (info.code ? FRIENDLY_ERRORS[info.code] : undefined) ?? info.message
  if (info.code === 'rate_limited' && info.retryAfter !== null) {
    const wait =
      info.retryAfter >= 120
        ? `${Math.ceil(info.retryAfter / 60)} minutes`
        : `${info.retryAfter} seconds`
    return `${base} Try again in ${wait}.`
  }
  return base
}

/** New-site settings collected by the publish pane and sent with Preview. */
export type PreviewSettings = {
  title: string
  expiration: string
  password: string
  enableData: boolean
}

/** The Turnstile surface the publish actions need; kept out of this module's setup. */
export type WorkspaceTurnstile = {
  isEnabled: Readonly<Ref<boolean>>
  token: Readonly<Ref<string | null>>
  reset: () => void
}

export type UseAiWorkspaceOptions = {
  /** Absent in tests and on servers without a Turnstile site key. */
  turnstile?: WorkspaceTurnstile
}

export function useAiWorkspace(options: UseAiWorkspaceOptions = {}) {
  const turnstile = options.turnstile
  const { saveResult } = useResultStorage()

  const state = ref<WorkspaceState | null>(null)
  const loading = ref(false)
  const loaded = ref(false)
  const loadError = ref<string | null>(null)
  const busy = ref(false)
  const errorCode = ref<string | null>(null)
  const errorMessage = ref<string | null>(null)
  const notice = ref<string | null>(null)

  const openPath = ref<string | null>(null)
  const openContent = ref<string | null>(null)
  const openLoading = ref(false)
  const openError = ref<string | null>(null)

  /** The most recent successful new-site publication, kept for the Studio's success state. */
  const publishedResult = ref<UploadResult | null>(null)

  const target = computed(() => state.value?.target ?? null)
  const transcript = computed(() => state.value?.messages ?? [])

  function applyError(e: unknown) {
    const info = readAiError(e)
    errorCode.value = info.code
    errorMessage.value = describeAiError(info)
  }

  function clearFeedback() {
    errorCode.value = null
    errorMessage.value = null
    notice.value = null
  }

  function closeFile() {
    openPath.value = null
    openContent.value = null
    openError.value = null
  }

  async function load(): Promise<void> {
    loading.value = true
    loadError.value = null
    try {
      const data = await $fetch<WorkspaceState>('/api/ai/files')
      state.value = data
      loaded.value = true
      // A revision change can delete or convert the file currently open.
      if (openPath.value && !data.files.some((file) => file.path === openPath.value && file.editable)) {
        closeFile()
      }
    } catch (e) {
      loadError.value = describeAiError(readAiError(e))
    } finally {
      loading.value = false
    }
  }

  /**
   * Send one paid generation turn. A failed turn is never resubmitted
   * automatically; the caller keeps the draft text.
   */
  async function sendMessage(text: string): Promise<boolean> {
    if (busy.value || !loaded.value || !state.value) return false
    const trimmed = text.trim()
    if (!trimmed) return false
    const bytes = countMessageBytes(trimmed)
    if (bytes > CHAT_MESSAGE_MAX_BYTES) {
      errorCode.value = 'request_too_large'
      errorMessage.value = `Your message is ${bytes} bytes; the limit is ${CHAT_MESSAGE_MAX_BYTES}. Shorten it and try again.`
      return false
    }
    busy.value = true
    clearFeedback()
    try {
      const result = await $fetch<ChatResponse>('/api/ai/chat', {
        method: 'POST',
        body: { message: trimmed, revision: state.value.revision },
      })
      notice.value = result.summary
      await load()
      return true
    } catch (e) {
      applyError(e)
      return false
    } finally {
      busy.value = false
    }
  }

  async function openFile(file: WorkspaceFile): Promise<void> {
    if (!file.editable || busy.value) return
    openPath.value = file.path
    openContent.value = null
    openError.value = null
    openLoading.value = true
    try {
      const path = file.path.split('/').map(encodeURIComponent).join('/')
      const data = await $fetch<{ path: string; content: string; bytes: number; revision: number }>(
        `/api/ai/files/${path}`
      )
      openContent.value = data.content
    } catch (e) {
      openError.value = describeAiError(readAiError(e))
    } finally {
      openLoading.value = false
    }
  }

  /**
   * Publish the current draft as a brand-new owned site. Returns the creation
   * result after saving it for the result page; never navigates by itself.
   */
  async function publishPreview(settings: PreviewSettings): Promise<UploadResult | null> {
    if (busy.value || !state.value || target.value) return null
    if (settings.enableData && !settings.password.trim()) {
      errorCode.value = 'invalid_request'
      errorMessage.value = 'The Data API requires a password — set one or untick “Enable Data API”.'
      return null
    }
    if (turnstile?.isEnabled.value && !turnstile.token.value) {
      errorCode.value = 'invalid_request'
      errorMessage.value = 'Please complete the captcha before previewing.'
      return null
    }
    busy.value = true
    clearFeedback()
    try {
      const body: Record<string, unknown> = {
        revision: state.value.revision,
        expiration: settings.expiration,
      }
      const title = settings.title.trim()
      const password = settings.password.trim()
      if (title) body.title = title
      if (password) body.password = password
      if (settings.enableData) body.enable_data = true
      if (turnstile?.token.value) body['cf-turnstile-response'] = turnstile.token.value

      const result = await $fetch<UploadResult>('/api/ai/preview', { method: 'POST', body })
      saveResult(result, { title })
      publishedResult.value = result
      return result
    } catch (e) {
      applyError(e)
      turnstile?.reset()
      return null
    } finally {
      busy.value = false
    }
  }

  /** Attach an existing owned site. This replaces the current draft. */
  async function attach(slug: string): Promise<boolean> {
    if (busy.value || !state.value || !slug) return false
    busy.value = true
    clearFeedback()
    try {
      await $fetch('/api/ai/attach', {
        method: 'POST',
        body: { slug, revision: state.value.revision },
      })
      notice.value = 'Attached the selected site. Text changes publish back to it.'
      publishedResult.value = null
      await load()
      return true
    } catch (e) {
      applyError(e)
      return false
    } finally {
      busy.value = false
    }
  }

  /**
   * Publish the attached draft to the site's own URL through the existing
   * replacement route's builder mode. The result URL is unchanged, and no
   * owner-token or new-create result flow is entered.
   */
  async function publishChanges(): Promise<boolean> {
    if (busy.value || !state.value || !target.value) return false
    if (turnstile?.isEnabled.value && !turnstile.token.value) {
      errorCode.value = 'invalid_request'
      errorMessage.value = 'Please complete the captcha before publishing.'
      return false
    }
    busy.value = true
    clearFeedback()
    try {
      const form = new FormData()
      form.append('ai_workspace_revision', String(state.value.revision))
      if (turnstile?.token.value) form.append('cf-turnstile-response', turnstile.token.value)
      await $fetch(`/api/uploads/${encodeURIComponent(target.value.slug)}/content`, { method: 'PUT', body: form })
      notice.value = `Published changes to ${target.value.url ?? target.value.slug}.`
      await load()
      return true
    } catch (e) {
      applyError(e)
      turnstile?.reset()
      return false
    } finally {
      busy.value = false
    }
  }

  /** Restore the attached site's bytes into the local draft; publication stays explicit. */
  async function restore(): Promise<boolean> {
    if (busy.value || !state.value || target.value === null) return false
    busy.value = true
    clearFeedback()
    try {
      await $fetch('/api/ai/restore', { method: 'POST', body: { revision: state.value.revision } })
      notice.value = 'Restored the previous version locally. Publish changes to make it live.'
      await load()
      return true
    } catch (e) {
      applyError(e)
      return false
    } finally {
      busy.value = false
    }
  }

  /** Leave attached mode: empty new-site workspace, new session, snapshot closed. */
  async function startNewSite(): Promise<boolean> {
    if (busy.value || !state.value) return false
    busy.value = true
    clearFeedback()
    try {
      await $fetch('/api/ai/reset', { method: 'POST', body: { revision: state.value.revision } })
      publishedResult.value = null
      notice.value = 'Started a new site. Describe what you want to build.'
      await load()
      return true
    } catch (e) {
      applyError(e)
      return false
    } finally {
      busy.value = false
    }
  }

  return {
    // workspace state
    state,
    target,
    transcript,
    loading,
    loaded,
    loadError,
    busy,
    errorCode,
    errorMessage,
    notice,
    publishedResult,
    // source inspection
    openPath,
    openContent,
    openLoading,
    openError,
    // actions
    load,
    sendMessage,
    openFile,
    closeFile,
    publishPreview,
    publishChanges,
    attach,
    restore,
    startNewSite,
  }
}
