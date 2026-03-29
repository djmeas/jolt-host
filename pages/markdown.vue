<script setup lang="ts">
const markdownUrl = '/api/markdown'
const content = ref('')
const submitting = ref(false)
const error = ref<string | null>(null)
const RESULT_BY_SLUG_PREFIX = 'jolthost-result-'

const turnstileContainer = ref<HTMLElement | null>(null)
const { token: turnstileToken, isEnabled: turnstileEnabled, renderWidget, reset: resetTurnstile, cleanup: cleanupTurnstile } = useTurnstile()

onMounted(() => {
  if (turnstileContainer.value) renderWidget(turnstileContainer.value)
})
onUnmounted(() => cleanupTurnstile())

type PasteResult = { url: string; slug: string; owner_token?: string; url_with_unlock?: string }

const expirationOptions = [
  { value: '1h', label: '1 hour' },
  { value: '8h', label: '8 hours' },
  { value: '1d', label: '1 day' },
  { value: '3d', label: '3 days' },
  { value: '1w', label: '1 week' },
] as const
const expiration = ref('1h')
const password = ref('')

function saveResultToStorage(res: PasteResult) {
  if (import.meta.client) {
    try {
      sessionStorage.setItem('jolthost-last-upload', JSON.stringify(res))
      sessionStorage.setItem(`${RESULT_BY_SLUG_PREFIX}${res.slug}`, JSON.stringify(res))
    } catch (_) {}
  }
}

function getErrorMessage(e: unknown): string {
  if (e && typeof e === 'object') {
    const err = e as { data?: { message?: string }; message?: string; statusMessage?: string }
    if (err.data?.message) return err.data.message
    if (err.message) return err.message
    if (err.statusMessage) return err.statusMessage
  }
  return 'Failed to publish.'
}

async function previewInNewTab() {
  const raw = content.value.trim()
  if (!raw) return
  // Dynamically import marked so it's only loaded client-side when needed
  const { marked } = await import('marked')
  const rendered = marked.parse(raw) as string
  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:800px;margin:2rem auto;padding:0 1rem;line-height:1.75;color:#1f2328}pre{background:#f6f8fa;padding:1rem;border-radius:8px;overflow-x:auto}code{background:#f6f8fa;padding:.2em .4em;border-radius:4px}a{color:#0969da}blockquote{border-left:4px solid #d0d7de;margin:0;padding:.5rem 1rem;color:#656d76}</style></head><body>${rendered}</body></html>`
  const blob = new Blob([doc], { type: 'text/html; charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const win = window.open(url, '_blank', 'noopener')
  if (win) URL.revokeObjectURL(url)
}

const errorEl = ref<HTMLElement | null>(null)
async function submitForm() {
  const markdown = content.value.trim()
  if (!markdown) return
  if (turnstileEnabled.value && !turnstileToken.value) {
    error.value = 'Please complete the captcha before publishing.'
    nextTick(() => errorEl.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
    return
  }
  error.value = null
  submitting.value = true
  try {
    const res = await $fetch<PasteResult>(markdownUrl, {
      method: 'POST',
      body: {
        markdown,
        expiration: expiration.value,
        password: password.value.trim(),
        ...(turnstileToken.value ? { 'cf-turnstile-response': turnstileToken.value } : {}),
      },
    })
    if (!res?.slug) {
      error.value = 'Invalid response from server.'
      return
    }
    saveResultToStorage(res)
    await useRouter().push(`/result/${res.slug}`)
  } catch (e: unknown) {
    error.value = getErrorMessage(e)
    resetTurnstile()
    nextTick(() => errorEl.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="page">
    <div class="box">
      <h1 class="title">Paste Markdown</h1>
      <p class="subtitle">Paste your Markdown below, set options, then publish</p>

      <div class="textarea-wrap">
        <textarea
          v-model="content"
          class="textarea"
          placeholder="# Hello World&#10;&#10;Write your **markdown** here.&#10;&#10;- Item one&#10;- Item two&#10;&#10;```js&#10;console.log('Hello')&#10;```"
          rows="14"
          :disabled="submitting"
        />
      </div>

      <button
        type="button"
        class="preview-btn"
        :disabled="!content.trim()"
        @click="previewInNewTab"
      >
        Preview
      </button>

      <div class="form-options">
        <div class="form-group">
          <label for="expiration" class="form-label">Expiration</label>
          <select
            id="expiration"
            v-model="expiration"
            class="form-select"
            :disabled="submitting"
          >
            <option
              v-for="opt in expirationOptions"
              :key="opt.value"
              :value="opt.value"
            >
              {{ opt.label }}
            </option>
          </select>
        </div>
        <div class="form-group">
          <label for="password" class="form-label">Password (optional)</label>
          <input
            id="password"
            v-model="password"
            type="password"
            class="form-input"
            placeholder="Password to view this paste"
            autocomplete="new-password"
            :disabled="submitting"
          />
        </div>
      </div>

      <div v-if="turnstileEnabled" ref="turnstileContainer" class="turnstile-wrap" />

      <button
        type="button"
        class="submit-btn"
        :disabled="!content.trim() || submitting || (turnstileEnabled && !turnstileToken)"
        @click="submitForm"
      >
        {{ submitting ? 'Publishing…' : 'Publish' }}
      </button>

      <div v-if="error" ref="errorEl" class="error-wrap" role="alert">
        <p class="error">{{ error }}</p>
        <button type="button" class="error-dismiss" aria-label="Dismiss" @click="error = null">×</button>
      </div>

      <NuxtLink to="/" class="back-link">← Back to upload</NuxtLink>
    </div>
  </div>
</template>

<style scoped>
.page {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.box {
  width: 100%;
  max-width: 420px;
  margin: 0 auto;
  padding: 2rem;
  background: #18181b;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 16px;
  text-align: center;
}
.title {
  margin: 0 0 0.25rem;
  font-size: 1.5rem;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.subtitle {
  margin: 0 0 1.5rem;
  font-size: 0.9rem;
  color: #a1a1aa;
}
.textarea-wrap {
  width: 100%;
}
.textarea {
  width: 100%;
  padding: 0.75rem;
  font-size: 0.875rem;
  font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 8px;
  color: #e4e4e7;
  resize: vertical;
  min-height: 8rem;
}
.textarea:focus {
  outline: none;
  border-color: rgba(167, 139, 250, 0.5);
}
.textarea:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}
.textarea::placeholder {
  color: #71717a;
}
.form-options {
  margin-top: 1.25rem;
  text-align: center;
}
.form-group {
  margin-bottom: 1rem;
}
.form-group:last-of-type {
  margin-bottom: 0;
}
.form-label {
  display: block;
  font-size: 0.9rem;
  color: #a1a1aa;
  margin-bottom: 0.35rem;
}
.form-select,
.form-input {
  width: 100%;
  padding: 0.5rem 0.75rem;
  font-size: 0.9rem;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 8px;
  color: #e4e4e7;
}
.form-select {
  cursor: pointer;
}
.form-select:focus,
.form-input:focus {
  outline: none;
  border-color: rgba(167, 139, 250, 0.5);
}
.form-select:disabled,
.form-input:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}
.form-input::placeholder {
  color: #71717a;
}
.preview-btn {
  margin-top: 0.75rem;
  width: 100%;
  padding: 0.5rem 1rem;
  font-size: 0.9rem;
  font-weight: 500;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 8px;
  color: #a1a1aa;
  cursor: pointer;
}
.preview-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.12);
  border-color: rgba(255, 255, 255, 0.3);
  color: #e4e4e7;
}
.preview-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.turnstile-wrap {
  margin-top: 1.25rem;
  display: flex;
  justify-content: center;
}
.submit-btn {
  margin-top: 1.25rem;
  width: 100%;
  padding: 0.65rem 1rem;
  font-size: 1rem;
  font-weight: 500;
  background: rgba(167, 139, 250, 0.25);
  border: 1px solid rgba(167, 139, 250, 0.5);
  border-radius: 8px;
  color: #c4b5fd;
  cursor: pointer;
}
.submit-btn:hover:not(:disabled) {
  background: rgba(167, 139, 250, 0.35);
}
.submit-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.error-wrap {
  margin: 1rem 0 0;
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  background: rgba(248, 113, 113, 0.12);
  border: 1px solid rgba(248, 113, 113, 0.3);
  border-radius: 8px;
}
.error-wrap .error {
  margin: 0;
  flex: 1;
  font-size: 0.875rem;
  color: #f87171;
}
.error-dismiss {
  flex-shrink: 0;
  background: none;
  border: none;
  color: #f87171;
  font-size: 1.25rem;
  line-height: 1;
  cursor: pointer;
  padding: 0 0.25rem;
  opacity: 0.9;
}
.error-dismiss:hover {
  opacity: 1;
}
.back-link {
  display: inline-block;
  margin-top: 1.5rem;
  font-size: 0.9rem;
  color: #a1a1aa;
  text-decoration: none;
}
.back-link:hover {
  color: #a78bfa;
}
</style>
