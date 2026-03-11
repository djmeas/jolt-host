<script setup lang="ts">
const pasteUrl = '/api/paste'
const html = ref('')
const submitting = ref(false)
const error = ref<string | null>(null)
const RESULT_BY_SLUG_PREFIX = 'jolthost-result-'

type PasteResult = { url: string; slug: string; owner_token?: string; url_with_unlock?: string }

const expirationOptions = [
  { value: '', label: 'Never' },
  { value: '1h', label: '1 hour' },
  { value: '8h', label: '8 hours' },
  { value: '24h', label: '24 hours' },
  { value: '1w', label: '1 week' },
] as const
const expiration = ref('')
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

const errorEl = ref<HTMLElement | null>(null)
async function submitForm() {
  const content = html.value.trim()
  if (!content) return
  error.value = null
  submitting.value = true
  try {
    const res = await $fetch<PasteResult>(pasteUrl, {
      method: 'POST',
      body: {
        html: content,
        expiration: expiration.value,
        password: password.value.trim(),
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
    nextTick(() => errorEl.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="page">
    <div class="box">
      <h1 class="title">Paste HTML</h1>
      <p class="subtitle">Paste your HTML below, set options, then publish</p>

      <div class="textarea-wrap">
        <textarea
          v-model="html"
          class="textarea"
          placeholder="&lt;!DOCTYPE html&gt;&#10;&lt;html&gt;&#10;  &lt;head&gt;&lt;title&gt;My Site&lt;/title&gt;&lt;/head&gt;&#10;  &lt;body&gt;&lt;h1&gt;Hello&lt;/h1&gt;&lt;/body&gt;&#10;&lt;/html&gt;"
          rows="12"
          :disabled="submitting"
        />
      </div>

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
              :key="opt.value || 'never'"
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
            placeholder="Password to view this site"
            autocomplete="new-password"
            :disabled="submitting"
          />
        </div>
      </div>

      <button
        type="button"
        class="submit-btn"
        :disabled="!html.trim() || submitting"
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
  background: rgba(255, 255, 255, 0.04);
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
