<script setup lang="ts">
import { joinURL } from 'ufo'

useHead({ meta: [{ name: 'robots', content: 'noindex, nofollow' }] })

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const RESULT_BY_SLUG_PREFIX = 'jolthost-result-'

const { data: siteConfig } = await useFetch('/api/config')
const { isLoggedIn, refresh } = useCurrentUser()
if (!isLoggedIn.value) await refresh()

const loginRequired = computed(() => siteConfig.value?.registeredUsersOnly && !isLoggedIn.value)
const logoUrl = joinURL(useRuntimeConfig().app.baseURL, 'JoltSlashLogo.png')

const ownerToken = ref('')
const selectedFile = ref<File | null>(null)
const uploading = ref(false)
const error = ref<string | null>(null)
const done = ref(false)
const resultUrl = ref('')

const fileInput = ref<HTMLInputElement | null>(null)

const turnstileContainer = ref<HTMLElement | null>(null)
const { token: turnstileToken, isEnabled: turnstileEnabled, renderWidget, reset: resetTurnstile, cleanup: cleanupTurnstile } = useTurnstile()

watch(turnstileContainer, (element) => {
  if (element) renderWidget(element)
}, { flush: 'post' })
onUnmounted(() => cleanupTurnstile())

onMounted(() => {
  try {
    const raw = sessionStorage.getItem(`${RESULT_BY_SLUG_PREFIX}${slug.value}`)
    if (raw) {
      const stored = JSON.parse(raw) as { owner_token?: string }
      if (stored.owner_token && !ownerToken.value) ownerToken.value = stored.owner_token
    }
  } catch (_) {}
})

const { siteUrlFor } = useSiteUrl()
const siteUrl = computed(() => siteUrlFor(slug.value))

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

function onSelectFile() {
  setFile(fileInput.value?.files?.[0] ?? null)
}

function changeFile() {
  fileInput.value?.click()
}

function getErrorMessage(e: unknown): string {
  if (e && typeof e === 'object') {
    const err = e as { data?: { message?: string }; message?: string; statusMessage?: string }
    if (err.data?.message) return err.data.message
    if (err.message) return err.message
    if (err.statusMessage) return err.statusMessage
  }
  return 'Update failed.'
}

const copied = ref(false)
async function copyUrl() {
  if (!resultUrl.value) return
  try {
    await navigator.clipboard.writeText(resultUrl.value)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch (_) {}
}

async function submitForm() {
  const file = selectedFile.value
  if (!file) return
  if (turnstileEnabled.value && !turnstileToken.value) {
    error.value = 'Please complete the captcha before uploading.'
    return
  }
  error.value = null
  uploading.value = true
  try {
    const form = new FormData()
    form.append('file', file)
    if (!loginRequired.value && ownerToken.value.trim()) {
      form.append('owner_token', ownerToken.value.trim())
    }
    if (turnstileToken.value) {
      form.append('cf-turnstile-response', turnstileToken.value)
    }
    const res = await $fetch<{ slug: string; url: string }>(`/api/uploads/${slug.value}/content`, {
      method: 'PUT',
      body: form,
    })
    resultUrl.value = res?.url || siteUrl.value
    done.value = true
  } catch (e: unknown) {
    error.value = getErrorMessage(e)
    resetTurnstile()
  } finally {
    uploading.value = false
  }
}
</script>

<template>
  <div class="page">
    <div class="box">
      <img :src="logoUrl" alt="Jolt Host" class="logo" width="240" height="97" />
      <template v-if="done">
        <p class="success">Replacement published</p>
        <p class="lead">Your site is live at its original URL</p>
        <a :href="resultUrl" target="_blank" rel="noopener" class="result-link">{{ resultUrl }}</a>
        <button type="button" class="copy-btn" @click="copyUrl">
          {{ copied ? 'Copied!' : 'Copy URL' }}
        </button>
        <NuxtLink to="/my-sites" class="back-link">← Back to My Sites</NuxtLink>
      </template>

      <template v-else-if="loginRequired && !isLoggedIn">
        <h1 class="title">Log in to replace files</h1>
        <p class="lead">This host requires a registered account to publish updates.</p>
        <NuxtLink to="/login" class="primary-link">Log in</NuxtLink>
        <NuxtLink v-if="siteConfig?.registrationEnabled" to="/register" class="back-link">Create an account</NuxtLink>
      </template>

      <template v-else>
        <h1 class="title">Replace files</h1>
        <p class="lead">
          Uploading replaces the entire published file set for
          <a :href="siteUrl" target="_blank" rel="noopener" class="site-link">{{ slug }}</a>.
          Omitted files are removed. The URL, password, and expiration stay the same.
        </p>

        <div
          class="dropzone"
          :class="{ uploading, 'has-file': selectedFile }"
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
            <button type="button" class="clear-file" :disabled="uploading" @click.stop="changeFile">
              Change file
            </button>
          </template>
          <template v-else>
            <span>Drag &amp; drop or click to choose a .html, .zip, or .md file</span>
          </template>
        </div>

        <div class="form-group">
          <label for="owner-token" class="form-label">Owner token</label>
          <input
            id="owner-token"
            v-model="ownerToken"
            type="text"
            class="form-input"
            placeholder="Required for anonymous uploads"
            autocomplete="off"
            :disabled="uploading"
          />
          <span class="form-hint">
            Signed-in owners and admins do not need a token.
          </span>
        </div>

        <div v-if="turnstileEnabled" ref="turnstileContainer" class="turnstile-wrap" />

        <button
          type="button"
          class="submit-btn"
          :disabled="!selectedFile || uploading || (turnstileEnabled && !turnstileToken)"
          @click="submitForm"
        >
          {{ uploading ? 'Publishing…' : 'Publish replacement' }}
        </button>

        <div v-if="error" class="error-wrap" role="alert">
          <p class="error">{{ error }}</p>
          <button type="button" class="error-dismiss" aria-label="Dismiss" @click="error = null">×</button>
        </div>

        <NuxtLink to="/" class="back-link">← Back to home</NuxtLink>
      </template>
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
  max-width: 460px;
  padding: 2rem;
  background: #18181b;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 16px;
  text-align: center;
}
.logo {
  display: block;
  margin: 0 auto 1.25rem;
  width: min(100%, 240px);
  height: auto;
}
.title {
  margin: 0 0 0.5rem;
  font-size: 1.4rem;
  font-weight: 600;
  color: #f4f4f5;
}
.lead {
  margin: 0 0 1.5rem;
  font-size: 0.9rem;
  color: #a1a1aa;
  line-height: 1.6;
}
.site-link {
  color: #a78bfa;
  text-decoration: none;
}
.site-link:hover {
  text-decoration: underline;
}
.dropzone {
  border: 2px dashed rgba(255, 255, 255, 0.15);
  border-radius: 12px;
  padding: 2rem;
  cursor: pointer;
  transition: border-color 0.2s, background 0.2s;
  position: relative;
  color: #a1a1aa;
  font-size: 0.9rem;
}
.dropzone:hover {
  border-color: rgba(255, 255, 255, 0.25);
  background: rgba(255, 255, 255, 0.02);
}
.dropzone.uploading {
  pointer-events: none;
  opacity: 0.8;
}
.dropzone.has-file {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.file-name {
  font-size: 0.9rem;
  color: #e4e4e7;
  word-break: break-all;
}
.clear-file {
  align-self: center;
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
.input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.form-group {
  margin-top: 1.25rem;
  text-align: left;
}
.form-label {
  display: block;
  font-size: 0.9rem;
  color: #a1a1aa;
  margin-bottom: 0.35rem;
}
.form-input {
  width: 100%;
  padding: 0.5rem 0.75rem;
  font-size: 0.9rem;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 8px;
  color: #e4e4e7;
}
.form-input:focus {
  outline: none;
  border-color: rgba(167, 139, 250, 0.5);
}
.form-input::placeholder {
  color: #71717a;
}
.form-hint {
  display: block;
  margin-top: 0.35rem;
  font-size: 0.75rem;
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
  text-align: left;
}
.error-dismiss {
  flex-shrink: 0;
  background: none;
  border: none;
  color: #f87171;
  font-size: 1.25rem;
  line-height: 1;
  cursor: pointer;
}
.success {
  margin: 0 0 0.5rem;
  font-size: 0.9rem;
  font-weight: 500;
  color: #22c55e;
}
.result-link {
  display: block;
  font-size: 0.95rem;
  color: #a78bfa;
  word-break: break-all;
  text-decoration: none;
  margin-bottom: 0.75rem;
}
.result-link:hover {
  text-decoration: underline;
}
.copy-btn {
  padding: 0.4rem 0.75rem;
  font-size: 0.8rem;
  background: rgba(167, 139, 250, 0.2);
  border: 1px solid rgba(167, 139, 250, 0.4);
  border-radius: 8px;
  color: #c4b5fd;
  cursor: pointer;
}
.copy-btn:hover {
  background: rgba(167, 139, 250, 0.3);
}
.primary-link {
  display: inline-block;
  padding: 0.6rem 1.25rem;
  font-size: 0.9rem;
  font-weight: 500;
  background: rgba(167, 139, 250, 0.15);
  border: 1px solid rgba(167, 139, 250, 0.35);
  border-radius: 8px;
  color: #c4b5fd;
  text-decoration: none;
}
.primary-link:hover {
  background: rgba(167, 139, 250, 0.25);
}
.back-link {
  display: block;
  margin-top: 1.5rem;
  font-size: 0.9rem;
  color: #a1a1aa;
  text-decoration: none;
}
.back-link:hover {
  color: #a78bfa;
}
</style>
