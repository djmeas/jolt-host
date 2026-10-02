<script setup lang="ts">
import type { UploadResult } from '~/composables/useResultStorage'

/**
 * AI Builder surface for the landing page's Build tab.
 *
 * The workspace is private: replies, summaries, and file contents are
 * rendered with Vue interpolation only (never `v-html`), and file text is
 * fetched as JSON rather than rendered on this origin. Publishing happens
 * through `POST /api/ai/preview`, which creates a real owned upload; the
 * resulting slug goes through the same sessionStorage result flow as the
 * ordinary upload form.
 */

type WorkspaceFile = { path: string; bytes: number; editable: boolean }
type TranscriptMessage = {
  id: string
  turn_id: string
  role: 'user' | 'assistant'
  content: string
  status: string
  created_at: string
}
type WorkspaceTarget = { slug: string; url: string | null }
type WorkspaceState = {
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
type ChatResponse = {
  turn_id: string
  summary: string
  files: string[]
  workspace_files: number
  revision: number
}

/** Leaves room for the JSON envelope inside the server's 8 KiB body cap. */
const CHAT_MESSAGE_MAX_BYTES = 7800

/** Preselected by `/?tab=build&edit=<slug>`; only identifies a site to confirm. */
const props = defineProps<{ editSlug?: string | null }>()

const { data: siteConfig } = useFetch('/api/config')
const { user, refresh: refreshUser } = useCurrentUser()
const builderAccessError = computed(() => {
  if (!user.value) return 'Sign in with a registered account to use AI Builder.'
  if (!user.value.ai_build_enabled) return 'Build mode is not enabled for your account — ask an admin.'
  if (siteConfig.value?.aiBuilderAvailable === false) return 'AI Builder is not available on this server.'
  return null
})
const { saveResult } = useResultStorage()
const router = useRouter()

const state = ref<WorkspaceState | null>(null)
const loading = ref(false)
const loaded = ref(false)
const loadError = ref<string | null>(null)
const busy = ref(false)
const errorCode = ref<string | null>(null)
const errorMessage = ref<string | null>(null)
const notice = ref<string | null>(null)

const message = ref('')
const messageBytes = computed(() => new TextEncoder().encode(message.value).length)
const messageTooLong = computed(() => messageBytes.value > CHAT_MESSAGE_MAX_BYTES)

const openPath = ref<string | null>(null)
const openContent = ref<string | null>(null)
const openLoading = ref(false)
const openError = ref<string | null>(null)

const previewTitle = ref('')
const previewExpiration = ref('1h')
const previewPassword = ref('')
const previewEnableData = ref(false)
const expirationOptions = [
  { value: '1h', label: '1 hour' },
  { value: '8h', label: '8 hours' },
  { value: '1d', label: '1 day' },
  { value: '3d', label: '3 days' },
  { value: '1w', label: '1 week' },
] as const

const target = computed(() => state.value?.target ?? null)
const dataApiToggleAvailable = computed(
  () => siteConfig.value?.dataFeatureAvailable === true && siteConfig.value?.dataApiToggleEnabled !== false
)

/** The site named by the query string, offered for explicit confirmation. */
const editSlug = computed(() => (typeof props.editSlug === 'string' && props.editSlug ? props.editSlug : null))
const attachPromptDismissed = ref(false)
const restoreConfirming = ref(false)
const resetConfirming = ref(false)
const pendingAttach = computed(
  () => editSlug.value !== null && !attachPromptDismissed.value && target.value?.slug !== editSlug.value
)

const turnstileContainer = ref<HTMLElement | null>(null)
const {
  token: turnstileToken,
  isEnabled: turnstileEnabled,
  renderWidget,
  reset: resetTurnstile,
  cleanup: cleanupTurnstile,
} = useTurnstile()

watch(turnstileContainer, (element) => {
  if (element) renderWidget(element)
}, { flush: 'post' })
onUnmounted(() => cleanupTurnstile())

/**
 * The server always answers failures as `{ error: { code, message } }` (plus a
 * top-level `retry_after` for 429). Provider bodies and keys never reach here.
 */
type AiErrorInfo = { code: string | null; message: string; retryAfter: number | null }

function readAiError(e: unknown): AiErrorInfo {
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
const FRIENDLY_ERRORS: Record<string, string> = {
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

function describeAiError(info: AiErrorInfo): string {
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

async function load() {
  if (builderAccessError.value) return
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

onMounted(async () => {
  if (!user.value) await refreshUser()
  await load()
})

async function sendMessage() {
  if (busy.value || !loaded.value || !state.value) return
  const text = message.value.trim()
  if (!text) return
  if (messageTooLong.value) {
    errorCode.value = 'request_too_large'
    errorMessage.value = `Your message is ${messageBytes.value} bytes; the limit is ${CHAT_MESSAGE_MAX_BYTES}. Shorten it and try again.`
    return
  }
  busy.value = true
  clearFeedback()
  try {
    const result = await $fetch<ChatResponse>('/api/ai/chat', {
      method: 'POST',
      body: { message: text, revision: state.value.revision },
    })
    message.value = ''
    notice.value = result.summary
    await load()
  } catch (e) {
    // A failed paid turn is never resubmitted automatically.
    applyError(e)
  } finally {
    busy.value = false
  }
}

async function openFile(file: WorkspaceFile) {
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

async function publishPreview() {
  if (busy.value || !state.value || target.value) return
  if (previewEnableData.value && !previewPassword.value.trim()) {
    errorCode.value = 'invalid_request'
    errorMessage.value = 'The Data API requires a password — set one or untick “Enable Data API”.'
    return
  }
  if (turnstileEnabled.value && !turnstileToken.value) {
    errorCode.value = 'invalid_request'
    errorMessage.value = 'Please complete the captcha before previewing.'
    return
  }
  busy.value = true
  clearFeedback()
  try {
    const body: Record<string, unknown> = {
      revision: state.value.revision,
      expiration: previewExpiration.value,
    }
    if (previewTitle.value.trim()) body.title = previewTitle.value.trim()
    if (previewPassword.value.trim()) body.password = previewPassword.value.trim()
    if (previewEnableData.value) body.enable_data = true
    if (turnstileToken.value) body['cf-turnstile-response'] = turnstileToken.value

    const result = await $fetch<UploadResult>('/api/ai/preview', { method: 'POST', body })
    saveResult(result, { title: previewTitle.value })
    await router.push(`/result/${result.slug}`)
  } catch (e) {
    applyError(e)
    if (turnstileEnabled.value) resetTurnstile()
  } finally {
    busy.value = false
  }
}

/** Attach the site named by the query string. This replaces the current draft. */
async function attachSite() {
  if (busy.value || !state.value || !editSlug.value) return
  busy.value = true
  clearFeedback()
  try {
    await $fetch('/api/ai/attach', {
      method: 'POST',
      body: { slug: editSlug.value, revision: state.value.revision },
    })
    attachPromptDismissed.value = true
    notice.value = 'Attached the selected site. Text changes publish back to it.'
    await load()
  } catch (e) {
    applyError(e)
  } finally {
    busy.value = false
  }
}

/**
 * Publish the attached draft to the site's own URL through the existing
 * replacement route's builder mode. The result URL is unchanged, and no
 * owner-token or new-create result flow is entered.
 */
async function publishChanges() {
  if (busy.value || !state.value || !target.value) return
  if (turnstileEnabled.value && !turnstileToken.value) {
    errorCode.value = 'invalid_request'
    errorMessage.value = 'Please complete the captcha before publishing.'
    return
  }
  busy.value = true
  clearFeedback()
  try {
    const form = new FormData()
    form.append('ai_workspace_revision', String(state.value.revision))
    if (turnstileToken.value) form.append('cf-turnstile-response', turnstileToken.value)
    await $fetch(`/api/uploads/${encodeURIComponent(target.value.slug)}/content`, { method: 'PUT', body: form })
    notice.value = `Published changes to ${target.value.url ?? target.value.slug}.`
    await load()
  } catch (e) {
    applyError(e)
    if (turnstileEnabled.value) resetTurnstile()
  } finally {
    busy.value = false
  }
}

/** Restore the attached site's bytes into the local draft; publication stays explicit. */
async function restoreVersion() {
  if (busy.value || !state.value || target.value === null) return
  busy.value = true
  clearFeedback()
  try {
    await $fetch('/api/ai/restore', { method: 'POST', body: { revision: state.value.revision } })
    restoreConfirming.value = false
    notice.value = 'Restored the previous version locally. Publish changes to make it live.'
    await load()
  } catch (e) {
    applyError(e)
  } finally {
    busy.value = false
  }
}

/** Leave attached mode: empty new-site workspace, new session, snapshot closed. */
async function startNewSite() {
  if (busy.value || !state.value) return
  busy.value = true
  clearFeedback()
  try {
    await $fetch('/api/ai/reset', { method: 'POST', body: { revision: state.value.revision } })
    attachPromptDismissed.value = true
    restoreConfirming.value = false
    resetConfirming.value = false
    notice.value = 'Started a new site. Describe what you want to build.'
    await load()
  } catch (e) {
    applyError(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="ai-builder">
    <p class="ai-intro">
      Describe a static site and the model writes the files. Every <strong>Preview</strong> publishes a
      new live site you own. <NuxtLink to="/dashboard">Open dashboard</NuxtLink>
    </p>

    <div v-if="builderAccessError || loadError" class="ai-alert ai-alert-error" role="alert">
      <span>{{ builderAccessError || loadError }}</span>
      <button v-if="!builderAccessError" type="button" class="ai-btn-inline" @click="load">Retry</button>
    </div>

    <template v-else>
      <div v-if="loading && !loaded" class="ai-empty">Loading workspace…</div>

      <template v-else>
        <div v-if="pendingAttach" class="ai-section ai-attach" role="region" aria-label="Attach an existing site">
          <h3 class="ai-section-title">Attach an existing site</h3>
          <p class="ai-warn">
            Attaching <strong>{{ editSlug }}</strong> replaces the current draft files and chat session with
            that site's live content. The site is not changed until you choose “Publish changes”.
          </p>
          <div class="ai-actions">
            <button type="button" class="ai-btn" :disabled="busy" @click="attachSite">
              {{ busy ? 'Attaching…' : `Attach ${editSlug}` }}
            </button>
            <button
              type="button"
              class="ai-btn ai-btn-quiet"
              :disabled="busy"
              @click="attachPromptDismissed = true"
            >
              Keep current draft
            </button>
          </div>
        </div>

        <div class="ai-transcript" aria-live="polite">
          <p v-if="!state?.messages?.length" class="ai-empty">
            No messages yet. Describe the site you want to build.
          </p>
          <div
            v-for="item in state?.messages ?? []"
            :key="item.id"
            class="ai-msg"
            :class="item.role === 'user' ? 'ai-msg-user' : 'ai-msg-assistant'"
          >
            <div class="ai-msg-role">
              {{ item.role === 'user' ? 'You' : 'Builder' }}
              <span v-if="item.status !== 'ok'" class="ai-msg-status">{{ item.status }}</span>
            </div>
            <p class="ai-msg-content">{{ item.content }}</p>
          </div>
        </div>

        <label class="ai-label" for="ai-message">Describe a new site or a change</label>
        <textarea
          id="ai-message"
          v-model="message"
          class="ai-textarea"
          rows="3"
          :disabled="busy"
          placeholder="A one-page portfolio with a dark theme and a contact section"
        />
        <div class="ai-meta">
          <span class="ai-counter" :class="{ 'ai-over': messageTooLong }">
            {{ messageBytes }} / {{ CHAT_MESSAGE_MAX_BYTES }} bytes
          </span>
          <button
            type="button"
            class="ai-btn ai-btn-primary"
            :disabled="busy || !message.trim() || messageTooLong"
            @click="sendMessage"
          >
            {{ busy ? 'Working…' : 'Send' }}
          </button>
        </div>

        <p v-if="notice" class="ai-alert ai-alert-notice">{{ notice }}</p>
        <div v-if="errorMessage" class="ai-alert ai-alert-error" role="alert">
          <span>{{ errorMessage }}</span>
          <button
            v-if="errorCode === 'workspace_conflict' || errorCode === 'workspace_busy'"
            type="button"
            class="ai-btn-inline"
            @click="load"
          >
            Refresh workspace
          </button>
        </div>

        <section class="ai-section">
          <h3 class="ai-section-title">
            Workspace files
            <span v-if="state" class="ai-count">
              {{ state.editable_files }} text · {{ state.opaque_files }} asset
            </span>
          </h3>
          <p v-if="!state?.files?.length" class="ai-empty">No files yet.</p>
          <ul v-else class="ai-file-list">
            <li v-for="file in state.files" :key="file.path">
              <button
                v-if="file.editable"
                type="button"
                class="ai-file"
                :class="{ active: openPath === file.path }"
                :disabled="busy"
                @click="openFile(file)"
              >
                <span class="ai-file-path">{{ file.path }}</span>
                <span class="ai-file-tag">text</span>
              </button>
              <div v-else class="ai-file ai-file-opaque">
                <span class="ai-file-path">{{ file.path }}</span>
                <span class="ai-file-tag">asset</span>
              </div>
            </li>
          </ul>

          <div v-if="openPath" class="ai-viewer">
            <div class="ai-viewer-head">
              <span class="ai-viewer-path">{{ openPath }}</span>
              <button type="button" class="ai-btn-inline" @click="closeFile">Close</button>
            </div>
            <p v-if="openError" class="ai-alert ai-alert-error">{{ openError }}</p>
            <pre v-else-if="openLoading" class="ai-viewer-body">Loading…</pre>
            <pre v-else class="ai-viewer-body">{{ openContent }}</pre>
          </div>
        </section>

        <section v-if="!target" class="ai-section">
          <h3 class="ai-section-title">Preview</h3>
          <p class="ai-hint">
            Preview publishes the current files as a new live site you own. It does not attach the
            workspace to that site, so you can keep iterating and publish again.
          </p>
          <div class="ai-form">
            <div class="ai-form-group">
              <label class="ai-label" for="ai-title">Title (optional)</label>
              <input
                id="ai-title"
                v-model="previewTitle"
                class="ai-input"
                type="text"
                maxlength="100"
                :disabled="busy"
                placeholder="My AI site"
              />
            </div>
            <div class="ai-form-group">
              <label class="ai-label" for="ai-expiration">Expiration</label>
              <select id="ai-expiration" v-model="previewExpiration" class="ai-select" :disabled="busy">
                <option v-for="opt in expirationOptions" :key="opt.value" :value="opt.value">
                  {{ opt.label }}
                </option>
              </select>
            </div>
            <div class="ai-form-group">
              <label class="ai-label" for="ai-password">Password (optional)</label>
              <input
                id="ai-password"
                v-model="previewPassword"
                class="ai-input"
                type="password"
                autocomplete="new-password"
                maxlength="200"
                :disabled="busy"
                placeholder="Password to view this site"
              />
            </div>
            <div v-if="dataApiToggleAvailable" class="ai-form-group">
              <label class="ai-check">
                <input v-model="previewEnableData" type="checkbox" :disabled="busy" />
                <span>Enable Data API</span>
              </label>
              <p class="ai-hint">Adds password-protected JSON storage. Requires a password.</p>
            </div>
          </div>
          <div v-if="turnstileEnabled" ref="turnstileContainer" class="ai-turnstile" />
          <button
            type="button"
            class="ai-btn ai-btn-primary"
            :disabled="busy || !state?.files?.length || (turnstileEnabled && !turnstileToken)"
            @click="publishPreview"
          >
            {{ busy ? 'Publishing…' : 'Preview (publish a new site)' }}
          </button>
        </section>

        <section v-else class="ai-section">
          <h3 class="ai-section-title">Attached site</h3>
          <p class="ai-hint">
            This workspace is attached to
            <a v-if="target.url" :href="target.url" target="_blank" rel="noopener noreferrer">{{ target.url }}</a>
            <span v-else>{{ target.slug }}</span>. Text changes publish back to the same URL; password,
            expiration, and data settings stay unchanged.
          </p>

          <div v-if="turnstileEnabled" ref="turnstileContainer" class="ai-turnstile" />

          <button
            type="button"
            class="ai-btn ai-btn-primary"
            :disabled="busy || !state?.files?.length || (turnstileEnabled && !turnstileToken)"
            @click="publishChanges"
          >
            {{ busy ? 'Publishing…' : 'Publish changes' }}
          </button>

          <div class="ai-actions">
            <button
              v-if="!restoreConfirming"
              type="button"
              class="ai-btn ai-btn-quiet"
              :disabled="busy || !state?.restore_available"
              @click="restoreConfirming = true"
            >
              Restore previous version
            </button>
            <template v-else>
              <p class="ai-warn">
                Restoring discards your current editable changes here and brings back the bytes this site
                had when it was attached. The live site stays unchanged until you publish.
              </p>
              <button type="button" class="ai-btn" :disabled="busy" @click="restoreVersion">
                {{ busy ? 'Restoring…' : 'Restore locally' }}
              </button>
              <button
                type="button"
                class="ai-btn ai-btn-quiet"
                :disabled="busy"
                @click="restoreConfirming = false"
              >
                Cancel
              </button>
            </template>
          </div>

          <div class="ai-actions">
            <template v-if="!resetConfirming">
              <button type="button" class="ai-btn ai-btn-quiet" :disabled="busy" @click="resetConfirming = true">
                Start a new site
              </button>
            </template>
            <template v-else>
              <p class="ai-warn">
                Starting a new site discards the attached draft files and this edit session. The live site
                keeps the files from your last publish.
              </p>
              <button type="button" class="ai-btn" :disabled="busy" @click="startNewSite">
                {{ busy ? 'Resetting…' : 'Discard and start new' }}
              </button>
              <button
                type="button"
                class="ai-btn ai-btn-quiet"
                :disabled="busy"
                @click="resetConfirming = false"
              >
                Cancel
              </button>
            </template>
          </div>

          <p class="ai-hint"><NuxtLink to="/dashboard">Open dashboard</NuxtLink></p>
        </section>
      </template>
    </template>
  </div>
</template>

<style scoped>
.ai-builder {
  text-align: left;
}
.ai-intro {
  margin: 0 0 1rem;
  font-size: 0.8125rem;
  line-height: 1.5;
  color: #a1a1aa;
}
.ai-intro a,
.ai-hint a {
  color: #a78bfa;
}
.ai-transcript {
  max-height: 16rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.75rem;
  margin-bottom: 1rem;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
}
.ai-msg-role {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #a1a1aa;
}
.ai-msg-status {
  margin-left: 0.5rem;
  padding: 0.05rem 0.35rem;
  border-radius: 4px;
  background: rgba(253, 224, 71, 0.15);
  color: #fde047;
  text-transform: none;
  letter-spacing: 0;
}
.ai-msg-content {
  margin: 0.15rem 0 0;
  font-size: 0.875rem;
  line-height: 1.5;
  color: #e4e4e7;
  white-space: pre-wrap;
  word-break: break-word;
}
.ai-empty {
  margin: 0;
  font-size: 0.875rem;
  color: #71717a;
}
.ai-label {
  display: block;
  font-size: 0.8125rem;
  color: #a1a1aa;
  margin-bottom: 0.35rem;
}
.ai-textarea,
.ai-input,
.ai-select {
  width: 100%;
  padding: 0.5rem 0.75rem;
  font: inherit;
  font-size: 0.875rem;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 8px;
  color: #e4e4e7;
  resize: vertical;
}
.ai-textarea:focus,
.ai-input:focus,
.ai-select:focus {
  outline: none;
  border-color: rgba(167, 139, 250, 0.5);
}
.ai-textarea:disabled,
.ai-input:disabled,
.ai-select:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}
.ai-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-top: 0.5rem;
}
.ai-counter {
  font-size: 0.75rem;
  color: #71717a;
}
.ai-counter.ai-over {
  color: #f87171;
}
.ai-btn {
  padding: 0.5rem 1rem;
  font: inherit;
  font-size: 0.875rem;
  font-weight: 600;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  background: rgba(255, 255, 255, 0.06);
  color: #e4e4e7;
  cursor: pointer;
}
.ai-btn-primary {
  width: 100%;
  margin-top: 0.75rem;
  background: rgba(253, 224, 71, 0.12);
  border-color: rgba(253, 224, 71, 0.4);
  color: #fde047;
}
.ai-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.ai-btn-inline {
  flex-shrink: 0;
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  font-size: 0.8125rem;
  color: #a78bfa;
  text-decoration: underline;
  cursor: pointer;
}
.ai-alert {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  margin: 0.75rem 0 0;
  padding: 0.5rem 0.75rem;
  border-radius: 8px;
  font-size: 0.8125rem;
  line-height: 1.5;
}
.ai-alert-error {
  background: rgba(248, 113, 113, 0.1);
  border: 1px solid rgba(248, 113, 113, 0.3);
  color: #fca5a5;
}
.ai-alert-notice {
  background: rgba(167, 139, 250, 0.1);
  border: 1px solid rgba(167, 139, 250, 0.3);
  color: #ddd6fe;
  white-space: pre-wrap;
  word-break: break-word;
}
.ai-section {
  margin-top: 1.25rem;
  padding-top: 1rem;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}
.ai-section-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
  margin: 0 0 0.5rem;
  font-size: 0.9375rem;
  font-weight: 600;
  color: #e4e4e7;
}
.ai-count {
  font-size: 0.75rem;
  font-weight: 400;
  color: #71717a;
}
.ai-hint {
  margin: 0 0 0.75rem;
  font-size: 0.8125rem;
  line-height: 1.5;
  color: #a1a1aa;
}
.ai-warn {
  margin: 0 0 0.75rem;
  padding: 0.5rem 0.75rem;
  font-size: 0.8125rem;
  line-height: 1.5;
  color: #fde047;
  background: rgba(253, 224, 71, 0.08);
  border: 1px solid rgba(253, 224, 71, 0.25);
  border-radius: 8px;
}
.ai-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.75rem;
}
.ai-actions .ai-btn {
  flex: 1 1 auto;
}
.ai-actions .ai-warn {
  flex: 1 1 100%;
}
.ai-btn-quiet {
  font-weight: 500;
}
.ai-attach .ai-btn:not(.ai-btn-quiet) {
  background: rgba(167, 139, 250, 0.12);
  border-color: rgba(167, 139, 250, 0.4);
  color: #ddd6fe;
}
.ai-file-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  max-height: 12rem;
  overflow-y: auto;
}
.ai-file {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  width: 100%;
  padding: 0.35rem 0.6rem;
  font: inherit;
  font-size: 0.8125rem;
  text-align: left;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid transparent;
  border-radius: 6px;
  color: #e4e4e7;
  cursor: pointer;
}
.ai-file:hover:not(:disabled) {
  border-color: rgba(167, 139, 250, 0.4);
}
.ai-file.active {
  border-color: rgba(167, 139, 250, 0.6);
  background: rgba(167, 139, 250, 0.1);
}
.ai-file:disabled {
  cursor: not-allowed;
}
.ai-file-opaque {
  cursor: default;
  color: #a1a1aa;
}
.ai-file-path {
  word-break: break-all;
}
.ai-file-tag {
  flex-shrink: 0;
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #71717a;
}
.ai-viewer {
  margin-top: 0.75rem;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  overflow: hidden;
}
.ai-viewer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.35rem 0.6rem;
  background: rgba(255, 255, 255, 0.05);
}
.ai-viewer-path {
  font-size: 0.75rem;
  color: #a1a1aa;
  word-break: break-all;
}
.ai-viewer-body {
  margin: 0;
  padding: 0.6rem;
  max-height: 18rem;
  overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.75rem;
  line-height: 1.5;
  color: #e4e4e7;
  white-space: pre-wrap;
  word-break: break-word;
}
.ai-form {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}
.ai-form-group {
  flex: 1 1 8rem;
}
.ai-check {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8125rem;
  color: #e4e4e7;
  cursor: pointer;
  user-select: none;
}
.ai-check input {
  accent-color: #a78bfa;
}
.ai-turnstile {
  margin-top: 0.75rem;
  display: flex;
  justify-content: center;
}
</style>
