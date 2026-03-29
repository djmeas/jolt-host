<script setup lang="ts">
const { charged } = useLightningCharge()
const uploadUrl = '/api/upload'
const fileInput = ref<HTMLInputElement | null>(null)
const dragging = ref(false)
const uploading = ref(false)
const error = ref<string | null>(null)
const RESULT_STORAGE_KEY = 'jolthost-last-upload'
const RESULT_BY_SLUG_PREFIX = 'jolthost-result-'

const turnstileContainer = ref<HTMLElement | null>(null)
const { token: turnstileToken, isEnabled: turnstileEnabled, renderWidget, reset: resetTurnstile, cleanup: cleanupTurnstile } = useTurnstile()

onMounted(() => {
  if (turnstileContainer.value) renderWidget(turnstileContainer.value)
})
onUnmounted(() => cleanupTurnstile())

type UploadResult = { url: string; slug: string; owner_token?: string; url_with_unlock?: string }

const expirationOptions = [
  { value: '1h', label: '1 hour' },
  { value: '8h', label: '8 hours' },
  { value: '1d', label: '1 day' },
  { value: '3d', label: '3 days' },
  { value: '1w', label: '1 week' },
] as const
const expiration = ref('1h')
const password = ref('')
const selectedFile = ref<File | null>(null)

function saveResultToStorage(res: UploadResult) {
  if (import.meta.client) {
    try {
      sessionStorage.setItem(RESULT_STORAGE_KEY, JSON.stringify(res))
      sessionStorage.setItem(`${RESULT_BY_SLUG_PREFIX}${res.slug}`, JSON.stringify(res))
    } catch (_) {}
  }
}

function setFile(file: File | null) {
  error.value = null
  if (file) {
    const name = file.name.toLowerCase()
    if (!name.endsWith('.html') && !name.endsWith('.zip') && !name.endsWith('.md')) {
      error.value = 'Only .html, .zip, or .md files are allowed.'
      selectedFile.value = null
      return
    }
    if (name.endsWith('.zip') && file.size > 5 * 1024 * 1024) {
      error.value = 'ZIP files must be 5MB or less.'
      selectedFile.value = null
      return
    }
  }
  selectedFile.value = file
}

function onDrop(e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()
  dragging.value = false
  const file = e.dataTransfer?.files?.[0]
  if (file) setFile(file)
  return false
}

function onDragOver(e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()
  dragging.value = true
  return false
}

function onDragLeave() {
  dragging.value = false
}

function onSelectFile() {
  const file = fileInput.value?.files?.[0]
  setFile(file ?? null)
}

function clearFile() {
  selectedFile.value = null
  error.value = null
  if (fileInput.value) fileInput.value.value = ''
}

function changeFile() {
  fileInput.value?.click()
}

function getUploadErrorMessage(e: unknown): string {
  if (e && typeof e === 'object') {
    const err = e as { data?: { message?: string }; message?: string; statusMessage?: string }
    if (err.data?.message) return err.data.message
    if (err.message) return err.message
    if (err.statusMessage) return err.statusMessage
  }
  return 'Upload failed.'
}

const errorEl = ref<HTMLElement | null>(null)
async function submitForm() {
  const file = selectedFile.value
  if (!file) return
  if (turnstileEnabled.value && !turnstileToken.value) {
    error.value = 'Please complete the captcha before uploading.'
    nextTick(() => errorEl.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
    return
  }
  error.value = null
  uploading.value = true
  try {
    const form = new FormData()
    form.append('file', file)
    if (expiration.value) {
      form.append('expiration', expiration.value)
    }
    if (password.value.trim()) {
      form.append('password', password.value.trim())
    }
    if (turnstileToken.value) {
      form.append('cf-turnstile-response', turnstileToken.value)
    }
    const res = await $fetch<UploadResult>(uploadUrl, {
      method: 'POST',
      body: form,
    })
    if (!res?.slug) {
      error.value = 'Invalid response from server.'
      return
    }
    saveResultToStorage(res)
    await useRouter().push(`/result/${res.slug}`)
  } catch (e: unknown) {
    error.value = getUploadErrorMessage(e)
    resetTurnstile()
    nextTick(() => errorEl.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
  } finally {
    uploading.value = false
  }
}

const preventDropNav = (e: DragEvent) => {
  if (e.dataTransfer?.types?.includes('Files')) {
    e.preventDefault()
  }
}
onMounted(() => {
  document.addEventListener('drop', preventDropNav, true)
  document.addEventListener('dragover', preventDropNav, true)
})
onUnmounted(() => {
  document.removeEventListener('drop', preventDropNav, true)
  document.removeEventListener('dragover', preventDropNav, true)
})
</script>

<template>
  <div class="page">
    <div class="box">
      <h1 class="title">Upload a static site</h1>
      <p class="subtitle">Choose an HTML file, Markdown, or ZIP<span class="zip-info-wrap"><span class="zip-info-icon" tabindex="0" aria-label="ZIP format requirements">ⓘ</span><span class="zip-info-tooltip" role="tooltip">Your ZIP must contain an <strong>index.html</strong> at the root of the archive. Nested HTML files and assets (images, CSS, JS) can be placed in subfolders.</span></span>, set options, then submit</p>

      <div
        class="dropzone"
        :class="{ dragging, uploading, 'has-file': selectedFile }"
        @drop.prevent="onDrop"
        @dragover.prevent="onDragOver"
        @dragleave="onDragLeave"
        @click="!selectedFile && fileInput?.click()"
      >
        <input
          ref="fileInput"
          type="file"
          accept=".html,.zip,.md"
          class="input"
          aria-hidden="true"
          tabindex="-1"
          @change="onSelectFile"
        />
        <template v-if="selectedFile">
          <span class="file-name">{{ selectedFile.name }}</span>
          <button
            type="button"
            class="clear-file"
            :disabled="uploading"
            @click.stop="changeFile"
          >
            Change file
          </button>
        </template>
        <template v-else>
          <span>Drag & drop or click to upload an HTML file, Markdown, or ZIP</span>
        </template>
      </div>

      <div v-if="!selectedFile" class="or-divider"><span>or</span></div>

      <div v-if="!selectedFile" class="paste-row">
        <NuxtLink to="/paste" class="paste-btn">Paste HTML</NuxtLink>
        <NuxtLink to="/editor" class="paste-btn">Edit HTML</NuxtLink>
      </div>
      <NuxtLink v-if="!selectedFile" to="/markdown" class="paste-btn">Paste Markdown</NuxtLink>

      <hr class="section-divider" />

      <div class="form-options">
        <div class="form-group">
          <label for="expiration" class="form-label">Expiration</label>
          <select
            id="expiration"
            v-model="expiration"
            class="form-select"
            :disabled="uploading"
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
            placeholder="Password to view this site"
            autocomplete="new-password"
            :disabled="uploading"
          />
        </div>
      </div>

      <div v-if="turnstileEnabled" ref="turnstileContainer" class="turnstile-wrap" />

      <button
        type="button"
        class="submit-btn"
        :disabled="!selectedFile || uploading || (turnstileEnabled && !turnstileToken)"
        @mouseenter="charged = true"
        @mouseleave="charged = false"
        @click="submitForm"
      >
        <template v-if="!uploading">
          <span
            v-for="(char, i) in 'Upload'"
            :key="i"
            class="submit-letter"
            :style="{ '--i': i }"
          >{{ char }}</span>
        </template>
        <template v-else>Uploading…</template>
      </button>

      <div v-if="error" ref="errorEl" class="error-wrap" role="alert">
        <p class="error">{{ error }}</p>
        <button type="button" class="error-dismiss" aria-label="Dismiss" @click="error = null">×</button>
      </div>
    </div>

    <p class="previewer-link-wrap" v-if="false">
      <NuxtLink to="/previewer" class="previewer-link">Don't need to publish? Use the HTML previewer.</NuxtLink>
    </p>
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
.dropzone {
  border: 2px dashed rgba(255, 255, 255, 0.15);
  border-radius: 12px;
  padding: 2rem;
  cursor: pointer;
  transition: border-color 0.2s, background 0.2s;
  position: relative;
}
.dropzone:hover {
  border-color: rgba(255, 255, 255, 0.25);
  background: rgba(255, 255, 255, 0.02);
}
.dropzone.dragging {
  border-color: #a78bfa;
  background: rgba(167, 139, 250, 0.08);
}
.dropzone.uploading {
  pointer-events: none;
  opacity: 0.8;
}
.dropzone.has-file {
  flex-direction: column;
  gap: 0.5rem;
}
.file-name {
  font-size: 0.9rem;
  word-break: break-all;
}
.clear-file {
  font-size: 0.8rem;
  padding: 0.25rem 0.5rem;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 6px;
  color: #a1a1aa;
  cursor: pointer;
}
.clear-file:hover:not(:disabled) {
  color: #e4e4e7;
  border-color: rgba(255, 255, 255, 0.35);
}
.clear-file:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
  width: 100%;
  height: 100%;
  pointer-events: none;
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
  background: rgba(253, 224, 71, 0.1);
  animation: lightning-pulse 0.9s ease-in-out infinite;
}
.submit-letter {
  display: inline-block;
}
.submit-btn:hover:not(:disabled) .submit-letter {
  animation: lightning-letter 2s ease-in-out infinite;
  animation-delay: calc(var(--i) * 0.11s);
}
@keyframes lightning-letter {
  0%, 60%, 100% {
    color: #c4b5fd;
    text-shadow: none;
    transform: translateY(0);
  }
  15% {
    color: #fff;
    text-shadow: 0 0 6px #fff, 0 0 14px #fde047;
    transform: translateY(-2px);
  }
  30% {
    color: #fde047;
    text-shadow: 0 0 10px #fde047, 0 0 24px rgba(253, 224, 71, 0.8), 0 0 48px rgba(253, 224, 71, 0.3);
    transform: translateY(-4px);
  }
  45% {
    color: #fef08a;
    text-shadow: 0 0 6px #fde047, 0 0 14px rgba(253, 224, 71, 0.5);
    transform: translateY(-1px);
  }
}
@keyframes lightning-pulse {
  0%, 100% {
    border-color: rgba(253, 224, 71, 0.45);
    box-shadow: 0 0 8px rgba(253, 224, 71, 0.25), 0 0 20px rgba(253, 224, 71, 0.1);
  }
  50% {
    border-color: rgba(253, 224, 71, 0.9);
    box-shadow: 0 0 18px rgba(253, 224, 71, 0.6), 0 0 40px rgba(253, 224, 71, 0.35), 0 0 70px rgba(253, 224, 71, 0.1);
  }
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
.zip-info-wrap {
  position: relative;
  display: inline-block;
  margin-left: 0.2em;
}
.zip-info-icon {
  font-size: 0.8rem;
  color: #71717a;
  cursor: default;
  vertical-align: middle;
  line-height: 1;
  outline: none;
}
.zip-info-icon:hover,
.zip-info-icon:focus {
  color: #a78bfa;
}
.zip-info-tooltip {
  display: none;
  position: absolute;
  left: 50%;
  top: calc(100% + 6px);
  transform: translateX(-50%);
  width: 220px;
  background: #1c1c1e;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  padding: 0.6rem 0.75rem;
  font-size: 0.78rem;
  color: #a1a1aa;
  text-align: left;
  line-height: 1.5;
  z-index: 10;
  pointer-events: none;
}
.zip-info-tooltip strong {
  color: #e4e4e7;
}
.zip-info-wrap:hover .zip-info-tooltip,
.zip-info-icon:focus + .zip-info-tooltip {
  display: block;
}
.section-divider {
  border: none;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  margin: 1.25rem 0 0;
}
.or-divider {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 1rem;
  color: #52525b;
  font-size: 0.8rem;
}
.or-divider::before,
.or-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: rgba(255, 255, 255, 0.08);
}
.paste-row {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.75rem;
}
.paste-row .paste-btn {
  margin-top: 0;
  flex: 1;
}
.paste-btn {
  display: block;
  margin-top: 0.75rem;
  width: 100%;
  padding: 0.5rem 1rem;
  font-size: 0.9rem;
  font-weight: 500;
  text-align: center;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 8px;
  color: #a1a1aa;
  text-decoration: none;
  cursor: pointer;
}
.paste-btn:hover {
  background: rgba(255, 255, 255, 0.04);
  border-color: rgba(255, 255, 255, 0.35);
  color: #e4e4e7;
}
.previewer-link-wrap {
  margin: 1.5rem 0 0;
  text-align: center;
}
.previewer-link {
  font-size: 0.9rem;
  color: #a1a1aa;
  text-decoration: none;
}
.previewer-link:hover {
  color: #a78bfa;
}
</style>
