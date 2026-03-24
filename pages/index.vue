<script setup lang="ts">
const uploadUrl = '/api/upload'
const fileInput = ref<HTMLInputElement | null>(null)
const dragging = ref(false)
const uploading = ref(false)
const error = ref<string | null>(null)
const RESULT_STORAGE_KEY = 'jolthost-last-upload'
const RESULT_BY_SLUG_PREFIX = 'jolthost-result-'

type UploadResult = { url: string; slug: string; owner_token?: string; url_with_unlock?: string }

const expirationOptions = [
  { value: '', label: 'Never' },
  { value: '1h', label: '1 hour' },
  { value: '8h', label: '8 hours' },
  { value: '24h', label: '24 hours' },
  { value: '1w', label: '1 week' },
] as const
const expiration = ref('')
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
    if (!name.endsWith('.html') && !name.endsWith('.zip')) {
      error.value = 'Only .html or .zip files are allowed.'
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
    nextTick(() => errorEl.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
  } finally {
    uploading.value = false
  }
}

const preventDropNav = (e: DragEvent) => {
  if (e.dataTransfer?.types?.includes('Files')) {
    e.preventDefault()
    e.stopPropagation()
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
      <p class="subtitle">Choose an HTML file or ZIP, set options, then submit</p>

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
          accept=".html,.zip"
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
          <span>Click to upload an HTML file or ZIP</span>
        </template>
      </div>

      <NuxtLink v-if="!selectedFile" to="/paste" class="paste-btn">Paste HTML</NuxtLink>
      <NuxtLink v-if="!selectedFile" to="/editor" class="paste-btn">Edit HTML</NuxtLink>

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
            :disabled="uploading"
          />
        </div>
      </div>

      <button
        type="button"
        class="submit-btn"
        :disabled="!selectedFile || uploading"
        @click="submitForm"
      >
        {{ uploading ? 'Uploading…' : 'Upload' }}
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
