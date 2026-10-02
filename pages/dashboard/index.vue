<script setup lang="ts">
useHead({ meta: [{ name: 'robots', content: 'noindex, nofollow' }] })

type UploadRow = {
  slug: string
  entry_point: string
  created_at: string
  expires_at: string | null
  password_hash?: string | null
  has_password?: boolean
  data_enabled?: boolean | number
  title?: string | null
  url?: string
  ai_editable?: boolean
}

type UploadsResponse = {
  items: UploadRow[]
  total: number
  page: number
  limit: number
  totalPages: number
}

const { user, isLoggedIn, refresh: refreshUser } = useCurrentUser()
const { data: adminSession } = await useFetch('/api/admin/session', { key: 'admin-session' })
const isAdmin = computed(() => adminSession.value?.authenticated ?? false)
const { data: siteConfig } = await useFetch('/api/config')
const dataFeatureAvailable = computed(() => siteConfig.value?.dataFeatureAvailable === true)
const aiBuilderAvailable = computed(() => siteConfig.value?.aiBuilderAvailable === true && !!user.value?.ai_build_enabled)
const { siteUrlFor, origins } = useSiteUrl()

if (!isLoggedIn.value) await refreshUser()
if (!isAdmin.value && !isLoggedIn.value) await navigateTo('/login')

const activeTab = ref<'uploads' | 'account'>('uploads')

// --- Uploads ---
const uploadsPage = ref(1)
const uploadsData = ref<UploadsResponse | null>(null)
const uploadsLoading = ref(false)
const uploadsError = ref<string | null>(null)

async function fetchUploads() {
  uploadsLoading.value = true
  uploadsError.value = null
  try {
    const endpoint = isAdmin.value ? '/api/admin/uploads' : '/api/user/uploads'
    uploadsData.value = await $fetch<UploadsResponse>(`${endpoint}?page=${uploadsPage.value}&limit=20`)
  } catch (e: unknown) {
    const err = e as { data?: { message?: string }; message?: string }
    uploadsError.value = err.data?.message ?? err.message ?? 'Failed to load uploads'
  } finally {
    uploadsLoading.value = false
  }
}

const uploads = computed(() => uploadsData.value?.items ?? [])
const uploadsTotal = computed(() => uploadsData.value?.total ?? 0)
const uploadsTotalPages = computed(() => uploadsData.value?.totalPages ?? 0)
const uploadsCurrentPage = computed(() => uploadsData.value?.page ?? 1)
const uploadsLimit = computed(() => uploadsData.value?.limit ?? 20)
const uploadsStartItem = computed(() => (uploadsCurrentPage.value - 1) * uploadsLimit.value + 1)
const uploadsEndItem = computed(() => Math.min(uploadsCurrentPage.value * uploadsLimit.value, uploadsTotal.value))

function goToUploadsPage(p: number) {
  uploadsPage.value = Math.max(1, Math.min(p, uploadsTotalPages.value))
  fetchUploads()
}

onMounted(() => {
  if (isAdmin.value || isLoggedIn.value) fetchUploads()
})

const formatDate = (iso: string) => {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function buildUrl(upload: UploadRow) {
  return upload.url || siteUrlFor(upload.slug)
}

function displayUrl(upload: UploadRow): string {
  return buildUrl(upload).replace(/^https?:\/\//, '')
}

const openMenuSlug = ref<string | null>(null)
const menuPosition = ref<{ top: number; left: number } | null>(null)

function toggleMenu(slug: string, evt?: Event) {
  if (openMenuSlug.value === slug) {
    openMenuSlug.value = null
    menuPosition.value = null
    return
  }
  openMenuSlug.value = slug
  if (evt?.currentTarget instanceof HTMLElement) {
    const rect = evt.currentTarget.getBoundingClientRect()
    menuPosition.value = {
      top: rect.bottom + window.scrollY + 4,
      left: rect.right + window.scrollX - 150,
    }
  }
}

function closeMenu() {
  openMenuSlug.value = null
  menuPosition.value = null
}

function goToUpdate(slug: string) {
  closeMenu()
  navigateTo(`/update/${slug}`)
}

onMounted(() => document.addEventListener('click', closeMenu))
onUnmounted(() => document.removeEventListener('click', closeMenu))

// --- Per-row inline actions ---
const editingPasswordSlug = ref<string | null>(null)
const inlinePassword = ref('')
const passwordSaving = ref(false)
const passwordError = ref<string | null>(null)

function startEditPassword(slug: string) {
  editingPasswordSlug.value = slug
  inlinePassword.value = ''
  passwordError.value = null
}

async function savePassword(slug: string, clearIt: boolean) {
  passwordSaving.value = true
  passwordError.value = null
  try {
    const endpoint = isAdmin.value ? `/api/admin/paste/${slug}/password` : `/api/user/uploads/${slug}/password`
    await $fetch(endpoint, {
      method: 'POST',
      body: { password: clearIt ? null : (inlinePassword.value || null) },
    })
    editingPasswordSlug.value = null
    inlinePassword.value = ''
    await fetchUploads()
  } catch (e: unknown) {
    const err = e as { data?: { message?: string }; message?: string }
    passwordError.value = err.data?.message ?? err.message ?? 'Failed to update password'
  } finally {
    passwordSaving.value = false
  }
}

const editingExpirySlug = ref<string | null>(null)
const inlineExpiry = ref('')
const expirySaving = ref(false)
const expiryError = ref<string | null>(null)

const expiryOptions = computed(() => {
  const opts = [
    { value: '1h', label: '1 hour' },
    { value: '8h', label: '8 hours' },
    { value: '24h', label: '24 hours' },
    { value: '1w', label: '1 week' },
  ]
  if (isAdmin.value || user.value?.never_expire === 1) {
    opts.push({ value: 'never', label: 'Never' })
  }
  return opts
})

const EXPIRY_OPTIONS_MS: Record<string, number> = {
  '1h':  1 * 60 * 60 * 1000,
  '8h':  8 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '1w':  7 * 24 * 60 * 60 * 1000,
}

function guessExpiryOption(createdAt: string, expiresAt: string | null): string {
  if (!expiresAt) return 'never'
  const diff = new Date(expiresAt).getTime() - new Date(createdAt).getTime()
  let closest = '1h'
  let closestDelta = Infinity
  for (const [key, ms] of Object.entries(EXPIRY_OPTIONS_MS)) {
    const delta = Math.abs(diff - ms)
    if (delta < closestDelta) { closestDelta = delta; closest = key }
  }
  return closest
}

function getExpiryLabel(createdAt: string, expiresAt: string | null): string {
  if (!expiresAt) return 'Never'
  const diff = new Date(expiresAt).getTime() - new Date(createdAt).getTime()
  const labels: Record<string, string> = {
    '1h': '1 hour', '8h': '8 hours', '24h': '24 hours', '1w': '1 week',
  }
  let closest = '1h'
  let closestDelta = Infinity
  for (const [key, ms] of Object.entries(EXPIRY_OPTIONS_MS)) {
    const delta = Math.abs(diff - ms)
    if (delta < closestDelta) { closestDelta = delta; closest = key }
  }
  // Only show label if it's a close match (within 5 minutes)
  return closestDelta < 5 * 60 * 1000 ? labels[closest] : formatDate(expiresAt)
}

function startEditExpiry(slug: string, upload: UploadRow) {
  editingExpirySlug.value = slug
  inlineExpiry.value = guessExpiryOption(upload.created_at, upload.expires_at)
  expiryError.value = null
}

async function saveExpiry(upload: UploadRow) {
  expirySaving.value = true
  expiryError.value = null
  try {
    const expiresAt = inlineExpiry.value === 'never' ? null : isAdmin.value
      ? new Date(new Date(upload.created_at).getTime() + EXPIRY_OPTIONS_MS[inlineExpiry.value]).toISOString()
      : inlineExpiry.value
    const endpoint = isAdmin.value ? `/api/admin/upload/${upload.slug}/expiration` : `/api/user/uploads/${upload.slug}/expiration`
    await $fetch(endpoint, {
      method: 'POST',
      body: { expiresAt },
    })
    editingExpirySlug.value = null
    inlineExpiry.value = ''
    await fetchUploads()
  } catch (e: unknown) {
    const err = e as { data?: { message?: string }; message?: string }
    expiryError.value = err.data?.message ?? err.message ?? 'Failed to update expiry'
  } finally {
    expirySaving.value = false
  }
}

// --- Site data API ---
const dataSavingSlug = ref<string | null>(null)
const dataError = ref<string | null>(null)

function isDataEnabled(upload: UploadRow): boolean {
  return upload.data_enabled === true || upload.data_enabled === 1
}

async function toggleData(upload: UploadRow) {
  dataSavingSlug.value = upload.slug
  dataError.value = null
  try {
    await $fetch(`/api/uploads/${upload.slug}/data`, {
      method: 'PUT',
      body: { enabled: !isDataEnabled(upload) },
    })
    await fetchUploads()
  } catch (e: unknown) {
    const err = e as { data?: { message?: string }; message?: string }
    dataError.value = err.data?.message ?? err.message ?? 'Failed to update site data'
  } finally {
    dataSavingSlug.value = null
  }
}

async function copyDataLoginUrl(upload: UploadRow) {
  const url = `${buildUrl(upload).replace(/\/$/, '')}/_jolt/data/login`
  try {
    await navigator.clipboard.writeText(url)
    dataError.value = null
  } catch {
    dataError.value = url
  }
}

async function copyDataApiBaseUrl(upload: UploadRow) {
  const url = dataApiBaseUrl(upload)
  try {
    await navigator.clipboard.writeText(url)
    dataError.value = null
  } catch {
    dataError.value = url
  }
}

function dataApiBaseUrl(upload: UploadRow): string {
  return `${buildUrl(upload).replace(/\/$/, '')}/_jolt/data/v1`
}

// --- Data API reference panel ---
// The body is rendered from docs/jolt-data-api.md by /api/data-api, so the
// dashboard never restates the API contract and cannot drift from the doc.
const dataApiPanelOpen = ref(false)
const dataApiDoc = ref<string | null>(null)
const dataApiDocLoading = ref(false)
const dataApiDocError = ref<string | null>(null)

const siteBaseHost = computed(() => {
  const base = origins.value.siteBaseOrigin
  if (!base) return ''
  try {
    return new URL(base).host
  } catch {
    return base.replace(/^https?:\/\//, '')
  }
})

const dataApiUrlScheme = computed(() => {
  const base = origins.value.siteBaseOrigin
  if (!base) return 'https'
  try {
    return new URL(base).protocol.replace(/:$/, '')
  } catch {
    return 'https'
  }
})

const dataApiUrlTemplate = computed(() =>
  siteBaseHost.value
    ? `${dataApiUrlScheme.value}://<slug>.${siteBaseHost.value}/_jolt/data/v1`
    : 'site base origin not configured'
)

const dataApiLoginTemplate = computed(() =>
  siteBaseHost.value
    ? `${dataApiUrlScheme.value}://<slug>.${siteBaseHost.value}/_jolt/data/login`
    : 'site base origin not configured'
)

const dataEnabledCount = computed(() => uploads.value.filter((u) => isDataEnabled(u)).length)

// --- Agent instruction copy ---
const dataApiAgentCopied = ref(false)
const dataApiAgentError = ref<string | null>(null)

const dataApiAgentInstructions = computed(() => {
  const base = dataApiUrlTemplate.value
  const login = dataApiLoginTemplate.value
  return `Use the Jolt Host Site Data API for my site.

Per-site URLs (replace <slug> with my site's slug):
- API base URL: ${base}
- Sign in for writes: ${login}

JSON API (same-origin only, no CORS):
- GET    ${base}/collections/<collection>/items?limit=&offset=   -> 200 {"items":[...],"next_offset":number|null}
- POST   ${base}/collections/<collection>/items                  -> 201 (body {"value": {…}})
- PATCH  ${base}/collections/<collection>/items/<id>             -> 200 (replaces the whole value)
- DELETE ${base}/collections/<collection>/items/<id>             -> 204

Rules:
- Reads need the view/unlock session; writes need a data-admin session from the login URL (site password). Credentials are HttpOnly cookies — use fetch() with relative URLs from pages served on the site host.
- Collections match ^[a-z][a-z0-9_-]{0,39}$; "value" must be a JSON object.
- Limits: 25 collections, 20,000 records, 64 KiB per record, 128 KiB request body.
- On 401 the response includes {"login_url": "..."} — surface that link so the visitor can sign in.`
})

async function copyDataApiAgentInstructions() {
  dataApiAgentError.value = null
  try {
    await navigator.clipboard.writeText(dataApiAgentInstructions.value)
    dataApiAgentCopied.value = true
    setTimeout(() => { dataApiAgentCopied.value = false }, 2000)
  } catch {
    dataApiAgentError.value = 'Clipboard unavailable — select and copy the text below.'
  }
}

async function toggleDataApiPanel() {
  dataApiPanelOpen.value = !dataApiPanelOpen.value
  if (!dataApiPanelOpen.value || dataApiDoc.value || dataApiDocLoading.value) return
  dataApiDocLoading.value = true
  dataApiDocError.value = null
  try {
    const res = await $fetch<{ html: string }>('/api/data-api')
    dataApiDoc.value = res.html
  } catch {
    dataApiDocError.value = 'Could not load the data API reference.'
  } finally {
    dataApiDocLoading.value = false
  }
}

// --- Account settings ---
const currentPassword = ref('')
const newPassword = ref('')
const confirmNewPassword = ref('')
const passwordChangeLoading = ref(false)
const passwordChangeError = ref<string | null>(null)
const passwordChangeSuccess = ref(false)

function isProtected(upload: UploadRow): boolean {
  return upload.has_password ?? Boolean(upload.password_hash)
}

async function changePassword() {
  passwordChangeError.value = null
  passwordChangeSuccess.value = false
  if (!currentPassword.value || !newPassword.value) return
  if (newPassword.value !== confirmNewPassword.value) {
    passwordChangeError.value = 'New passwords do not match.'
    return
  }
  passwordChangeLoading.value = true
  try {
    await $fetch('/api/user/password', {
      method: 'POST',
      body: { currentPassword: currentPassword.value, newPassword: newPassword.value },
    })
    passwordChangeSuccess.value = true
    currentPassword.value = ''
    newPassword.value = ''
    confirmNewPassword.value = ''
  } catch (e: unknown) {
    const err = e as { data?: { message?: string }; message?: string }
    passwordChangeError.value = err.data?.message ?? err.message ?? 'Failed to change password'
  } finally {
    passwordChangeLoading.value = false
  }
}

// --- API tokens ---
type ApiToken = { id: string; nickname: string; created_at: string }
const tokens = ref<ApiToken[]>([])
const tokensLoading = ref(false)
const tokenError = ref<string | null>(null)
const newTokenName = ref('')
const tokenCreating = ref(false)
const revealedToken = ref<string | null>(null)
const tokenCopied = ref(false)

async function fetchTokens() {
  tokensLoading.value = true
  tokenError.value = null
  try {
    const data = await $fetch<{ tokens: ApiToken[] }>('/api/user/tokens')
    tokens.value = data.tokens
  } catch (e: unknown) {
    const err = e as { data?: { message?: string }; message?: string }
    tokenError.value = err.data?.message ?? err.message ?? 'Failed to load API tokens'
  } finally {
    tokensLoading.value = false
  }
}

async function createToken() {
  if (!newTokenName.value.trim()) return
  tokenError.value = null
  tokenCreating.value = true
  revealedToken.value = null
  try {
    const res = await $fetch<{ token: string; nickname: string }>('/api/user/tokens', {
      method: 'POST',
      body: { nickname: newTokenName.value.trim() },
    })
    revealedToken.value = res.token
    newTokenName.value = ''
    await fetchTokens()
  } catch (e: unknown) {
    const err = e as { data?: { message?: string }; message?: string }
    tokenError.value = err.data?.message ?? err.message ?? 'Failed to create token'
  } finally {
    tokenCreating.value = false
  }
}

async function copyRevealedToken() {
  if (!revealedToken.value) return
  try {
    await navigator.clipboard.writeText(revealedToken.value)
    tokenCopied.value = true
    setTimeout(() => { tokenCopied.value = false }, 2000)
  } catch {
    tokenError.value = 'Failed to copy to clipboard'
  }
}

async function revokeToken(nickname: string) {
  if (!confirm(`Revoke API token "${nickname}"? This cannot be undone.`)) return
  try {
    await $fetch('/api/user/tokens/delete', { method: 'POST', body: { nickname } })
    if (revealedToken.value) revealedToken.value = null
    await fetchTokens()
  } catch {
    alert('Failed to revoke token')
  }
}

onMounted(() => {
  if (!isAdmin.value && isLoggedIn.value) fetchTokens()
})
</script>

<template>
  <div class="page">
    <div class="dashboard">
      <div class="header">
        <h1 class="title">Dashboard</h1>
        <NuxtLink v-if="aiBuilderAvailable" to="/?tab=build" class="header-ai-link">AI Builder</NuxtLink>
        <span v-if="isAdmin" class="header-user">Admin</span>
        <span v-else-if="user" class="header-user">{{ user.name }}</span>
      </div>

      <div class="tabs">
        <button
          type="button"
          class="tab-btn"
          :class="{ active: activeTab === 'uploads' }"
          @click="activeTab = 'uploads'"
        >
          {{ isAdmin ? 'All Uploads' : 'My Uploads' }}
        </button>
        <button
          v-if="!isAdmin"
          type="button"
          class="tab-btn"
          :class="{ active: activeTab === 'account' }"
          @click="activeTab = 'account'"
        >
          Account Settings
        </button>
      </div>

      <!-- My Uploads -->
      <section v-if="activeTab === 'uploads'" class="section">
        <p v-if="uploadsError" class="section-error">{{ uploadsError }}</p>
        <p v-if="dataError" class="section-error">{{ dataError }}</p>

        <section v-if="dataFeatureAvailable" class="data-api-panel">
          <button
            type="button"
            class="data-api-panel__toggle"
            :aria-expanded="dataApiPanelOpen"
            @click="toggleDataApiPanel"
          >
            <span class="data-api-panel__chevron" :class="{ 'is-open': dataApiPanelOpen }" aria-hidden="true">▸</span>
            Data API reference
            <span class="data-api-panel__meta">
              {{ dataEnabledCount }} of {{ uploads.length }} on this page enabled
            </span>
          </button>

          <div v-if="dataApiPanelOpen" class="data-api-panel__body">
            <p class="data-api-panel__lead">
              Site data is opt-in per site and always served from the site's own origin. Turn it on from the
              <strong>Data API</strong> column below, then copy the URLs a client needs. Unlock links stay
              read-only; writing requires the site password.
            </p>

            <div class="data-api-agent">
              <div class="data-api-agent__row">
                <div class="data-api-agent__text">
                  <strong>Wiring a site up to the Data API?</strong>
                  <span>Copy these instructions and give them to your coding agent — Claude Code, Codex, Cursor, etc. — to do it for you.</span>
                </div>
                <button
                  type="button"
                  class="action-btn"
                  @click="copyDataApiAgentInstructions"
                >
                  {{ dataApiAgentCopied ? 'Copied!' : 'Copy agent instructions' }}
                </button>
              </div>
              <p v-if="dataApiAgentError" class="section-error data-api-agent__error">{{ dataApiAgentError }}</p>
              <pre v-if="dataApiAgentError" class="data-api-agent__fallback">{{ dataApiAgentInstructions }}</pre>
            </div>

            <dl class="data-api-urls">
              <div class="data-api-url">
                <dt>API base URL — per site</dt>
                <dd><code>{{ dataApiUrlTemplate }}</code></dd>
              </div>
              <div class="data-api-url">
                <dt>Write session — per site</dt>
                <dd><code>{{ dataApiLoginTemplate }}</code></dd>
              </div>
            </dl>

            <p class="data-api-panel__hint">
              Use <em>Copy API base URL</em> or <em>Copy data login URL</em> in a row's ⋯ menu to copy the
              real URL for that site.
            </p>

            <p v-if="dataApiDocLoading" class="data-api-panel__status">Loading reference…</p>
            <p v-else-if="dataApiDocError" class="section-error">{{ dataApiDocError }}</p>
            <article v-else-if="dataApiDoc" class="data-api-doc" v-html="dataApiDoc" />
          </div>
        </section>

        <div v-if="uploadsLoading && !uploadsData" class="empty muted">Loading…</div>

        <div v-else-if="uploads.length === 0 && uploadsData" class="empty muted">
          <template v-if="isAdmin">No uploads yet.</template>
          <template v-else>No uploads yet. <NuxtLink to="/" class="link">Upload your first site</NuxtLink>.</template>
        </div>

        <div v-else-if="uploads.length > 0" class="uploads-section">
          <div class="pagination-bar">
            <span class="pagination-info">Showing {{ uploadsStartItem }}–{{ uploadsEndItem }} of {{ uploadsTotal }}</span>
            <div class="pagination-controls">
              <button type="button" class="pagination-btn" :disabled="uploadsCurrentPage <= 1" title="First page" @click="goToUploadsPage(1)">««</button>
              <button type="button" class="pagination-btn" :disabled="uploadsCurrentPage <= 1" @click="goToUploadsPage(uploadsCurrentPage - 1)">‹ Previous</button>
              <span class="pagination-pages">Page {{ uploadsCurrentPage }} of {{ uploadsTotalPages }}</span>
              <button type="button" class="pagination-btn" :disabled="uploadsCurrentPage >= uploadsTotalPages" @click="goToUploadsPage(uploadsCurrentPage + 1)">Next ›</button>
              <button type="button" class="pagination-btn" :disabled="uploadsCurrentPage >= uploadsTotalPages" title="Last page" @click="goToUploadsPage(uploadsTotalPages)">»»</button>
            </div>
          </div>
          <div class="table-container">
            <table class="uploads-table">
              <thead>
                <tr>
                  <th class="col-url">Site</th>
                  <th class="col-date">Created</th>
                  <th class="col-expires">Expires</th>
                  <th class="col-protected">Password</th>
                  <th class="col-protected">Data API</th>
                  <th class="col-actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(u, idx) in uploads" :key="u.slug" :class="{ 'row-alt': idx % 2 === 1 }">
                  <td class="col-url">
                    <p v-if="u.title" class="site-title">{{ u.title }}</p>
                    <a :href="buildUrl(u)" target="_blank" rel="noopener" class="url-link" :title="buildUrl(u)">{{ displayUrl(u) }}</a>
                  </td>
                  <td class="col-date muted">{{ formatDate(u.created_at) }}</td>
                  <td class="col-expires muted">
                    <span v-if="u.expires_at">
                      {{ getExpiryLabel(u.created_at, u.expires_at) }}
                      <span class="expiry-date">({{ formatDate(u.expires_at) }})</span>
                    </span>
                    <span v-else>Never</span>
                  </td>
                  <td class="col-protected">
                    <span :class="['badge', isProtected(u) ? 'badge-yes' : 'badge-no']">
                      {{ isProtected(u) ? 'Yes' : 'No' }}
                    </span>
                  </td>
                  <td class="col-protected">
                    <span :class="['badge', isDataEnabled(u) ? 'badge-yes' : 'badge-no']">
                      {{ isDataEnabled(u) ? 'On' : 'Off' }}
                    </span>
                    <span v-if="!isDataEnabled(u) && !isProtected(u)" class="data-hint">needs password</span>
                  </td>
                  <td class="col-actions">
                    <!-- Password editing -->
                    <template v-if="editingPasswordSlug === u.slug">
                      <div class="inline-form">
                        <input
                          v-model="inlinePassword"
                          type="password"
                          class="inline-input"
                          placeholder="New password"
                          :disabled="passwordSaving"
                          @keydown.enter="savePassword(u.slug, false)"
                        />
                        <button type="button" class="action-btn" :disabled="passwordSaving" @click="savePassword(u.slug, false)">
                          Save
                        </button>
                        <button type="button" class="action-btn danger" :disabled="passwordSaving" @click="savePassword(u.slug, true)">
                          Clear
                        </button>
                        <button type="button" class="action-btn muted" @click="editingPasswordSlug = null">
                          Cancel
                        </button>
                        <p v-if="passwordError" class="inline-error">{{ passwordError }}</p>
                      </div>
                    </template>
                    <!-- Expiry editing -->
                    <template v-else-if="editingExpirySlug === u.slug">
                      <div class="inline-form">
                        <select v-model="inlineExpiry" class="inline-select" :disabled="expirySaving">
                          <option v-for="opt in expiryOptions" :key="opt.value" :value="opt.value">
                            {{ opt.label }}
                          </option>
                        </select>
                        <button type="button" class="action-btn" :disabled="expirySaving" @click="saveExpiry(u)">
                          Save
                        </button>
                        <button type="button" class="action-btn muted" @click="editingExpirySlug = null">
                          Cancel
                        </button>
                        <p v-if="expiryError" class="inline-error">{{ expiryError }}</p>
                      </div>
                    </template>
                    <!-- Default actions -->
                    <template v-else>
                      <div class="menu-wrapper">
                        <button type="button" class="meatball-btn" @click.stop="toggleMenu(u.slug, $event)">⋯</button>
                        <Teleport to="body" v-if="openMenuSlug === u.slug && menuPosition">
                          <div class="menu-dropdown" :style="{ position: 'fixed', top: menuPosition.top + 'px', left: menuPosition.left + 'px' }">
                            <button type="button" class="menu-item" @click="startEditPassword(u.slug); closeMenu()">Change password</button>
                            <button type="button" class="menu-item" @click="startEditExpiry(u.slug, u); closeMenu()">Change expiry</button>
                            <button type="button" class="menu-item" @click="goToUpdate(u.slug)">Replace files</button>
                            <NuxtLink
                              v-if="aiBuilderAvailable && u.ai_editable"
                              :to="`/?tab=build&edit=${encodeURIComponent(u.slug)}`"
                              class="menu-item menu-item-link"
                              @click="closeMenu()"
                            >
                              Edit with AI
                            </NuxtLink>
                            <button
                              type="button"
                              class="menu-item"
                              :disabled="!dataFeatureAvailable || !isProtected(u) || dataSavingSlug === u.slug"
                              :title="isProtected(u) ? '' : 'A password is required for site data'"
                              @click="toggleData(u); closeMenu()"
                            >
                              {{ isDataEnabled(u) ? 'Disable data API' : 'Enable data API' }}
                            </button>
                            <button
                              v-if="isDataEnabled(u)"
                              type="button"
                              class="menu-item"
                              @click="copyDataLoginUrl(u); closeMenu()"
                            >
                              Copy data login URL
                            </button>
                            <button
                              v-if="isDataEnabled(u)"
                              type="button"
                              class="menu-item"
                              @click="copyDataApiBaseUrl(u); closeMenu()"
                            >
                              Copy API base URL
                            </button>
                          </div>
                        </Teleport>
                      </div>
                    </template>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="pagination-bar">
            <span class="pagination-info">
              Showing {{ uploadsStartItem }}–{{ uploadsEndItem }} of {{ uploadsTotal }}
            </span>
            <div class="pagination-controls">
              <button
                type="button"
                class="pagination-btn"
                :disabled="uploadsCurrentPage <= 1"
                title="First page"
                @click="goToUploadsPage(1)"
              >
                ««
              </button>
              <button
                type="button"
                class="pagination-btn"
                :disabled="uploadsCurrentPage <= 1"
                @click="goToUploadsPage(uploadsCurrentPage - 1)"
              >
                ‹ Previous
              </button>
              <span class="pagination-pages">Page {{ uploadsCurrentPage }} of {{ uploadsTotalPages }}</span>
              <button
                type="button"
                class="pagination-btn"
                :disabled="uploadsCurrentPage >= uploadsTotalPages"
                @click="goToUploadsPage(uploadsCurrentPage + 1)"
              >
                Next ›
              </button>
              <button
                type="button"
                class="pagination-btn"
                :disabled="uploadsCurrentPage >= uploadsTotalPages"
                title="Last page"
                @click="goToUploadsPage(uploadsTotalPages)"
              >
                »»
              </button>
            </div>
          </div>

          <p class="data-note">
            Site data is shared: everyone who has the site password can read and edit it, and unlock
            links can only read. Disabling keeps the records; setting a new password reveals the same
            records to whoever holds the new password. Deleting the site deletes them.
          </p>
        </div>
      </section>

      <!-- Account Settings -->
      <section v-if="!isAdmin && activeTab === 'account'" class="section">
        <h2 class="section-title">Change password</h2>
        <div class="account-card">
          <form class="account-form" @submit.prevent="changePassword">
            <div class="form-group">
              <label class="form-label">Current password</label>
              <input
                v-model="currentPassword"
                type="password"
                class="form-input"
                autocomplete="current-password"
                :disabled="passwordChangeLoading"
              />
            </div>
            <div class="form-group">
              <label class="form-label">New password</label>
              <input
                v-model="newPassword"
                type="password"
                class="form-input"
                autocomplete="new-password"
                :disabled="passwordChangeLoading"
              />
            </div>
            <div class="form-group">
              <label class="form-label">Confirm new password</label>
              <input
                v-model="confirmNewPassword"
                type="password"
                class="form-input"
                autocomplete="new-password"
                :disabled="passwordChangeLoading"
              />
            </div>
            <button
              type="submit"
              class="submit-btn"
              :disabled="passwordChangeLoading || !currentPassword || !newPassword || !confirmNewPassword"
            >
              {{ passwordChangeLoading ? 'Saving…' : 'Change password' }}
            </button>
          </form>
          <p v-if="passwordChangeError" class="form-error">{{ passwordChangeError }}</p>
          <p v-if="passwordChangeSuccess" class="form-success">Password changed successfully.</p>
        </div>

        <h2 class="section-title">API tokens</h2>
        <div class="account-card">
          <p class="section-desc">
            Use a token for programmatic uploads:
            <code>Authorization: Bearer &lt;token&gt;</code>.
            Sites you publish with a token appear in My Uploads.
          </p>

          <div v-if="revealedToken" class="token-reveal">
            <p class="token-warning">Copy this token now. It will not be shown again.</p>
            <div class="token-display">
              <code class="token-value">{{ revealedToken }}</code>
              <button type="button" class="action-btn" @click="copyRevealedToken">
                {{ tokenCopied ? 'Copied!' : 'Copy' }}
              </button>
            </div>
            <button type="button" class="action-btn muted" @click="revealedToken = null">I've copied it</button>
          </div>

          <form v-else class="token-create" @submit.prevent="createToken">
            <input
              v-model="newTokenName"
              type="text"
              class="form-input"
              placeholder="Token nickname (e.g. CI pipeline)"
              :disabled="tokenCreating"
            />
            <button type="submit" class="submit-btn" :disabled="tokenCreating || !newTokenName.trim()">
              {{ tokenCreating ? 'Creating…' : 'Generate token' }}
            </button>
          </form>
          <p v-if="tokenError" class="form-error">{{ tokenError }}</p>

          <div v-if="tokens.length > 0" class="token-list">
            <div v-for="t in tokens" :key="t.id" class="token-row">
              <span class="token-nickname">{{ t.nickname }}</span>
              <span class="token-created muted">{{ formatDate(t.created_at) }}</span>
              <button type="button" class="action-btn danger" @click="revokeToken(t.nickname)">Revoke</button>
            </div>
          </div>
          <p v-else-if="!tokensLoading && !revealedToken" class="empty muted">No API tokens yet.</p>
        </div>
      </section>

      <NuxtLink to="/" class="back-link">← Back to home</NuxtLink>
    </div>
  </div>
</template>

<style scoped>
.page {
  width: 100%;
  align-self: flex-start;
}
.dashboard {
  width: 100%;
  max-width: 1100px;
  margin: 0 auto;
  padding: 2rem;
}
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
}
.title {
  margin: 0;
  font-size: 1.5rem;
  font-weight: 600;
}
.header-user {
  font-size: 0.9rem;
  color: #a1a1aa;
}
.header-ai-link {
  font-size: 0.85rem;
  font-weight: 600;
  padding: 0.3rem 0.7rem;
  border: 1px solid rgba(253, 224, 71, 0.4);
  border-radius: 999px;
  color: #fde047;
  text-decoration: none;
}
.header-ai-link:hover {
  background: rgba(253, 224, 71, 0.12);
}
.tabs {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1.5rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  padding-bottom: 0;
}
.tab-btn {
  padding: 0.5rem 1rem;
  font-size: 0.95rem;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: #a1a1aa;
  cursor: pointer;
  margin-bottom: -1px;
}
.tab-btn:hover {
  color: #e4e4e7;
}
.tab-btn.active {
  color: #c4b5fd;
  border-bottom-color: #a78bfa;
}
.section {
  margin-bottom: 1.5rem;
}
.section-title {
  margin: 0 0 1rem;
  font-size: 1.1rem;
  font-weight: 600;
}
.section-error {
  margin: 0 0 1rem;
  font-size: 0.9rem;
  color: #f87171;
}
.empty {
  padding: 2rem;
  text-align: center;
}
.muted {
  color: #71717a;
}
.link {
  color: #a78bfa;
  text-decoration: none;
}
.link:hover {
  text-decoration: underline;
}
.uploads-section {
  margin-bottom: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.table-container {
  overflow-x: auto;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.02);
}
.uploads-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.uploads-table thead {
  position: sticky;
  top: 0;
  z-index: 1;
  background: rgba(15, 15, 18, 0.98);
}
.uploads-table th {
  padding: 0.75rem 1rem;
  text-align: left;
  font-weight: 600;
  color: #a1a1aa;
  border-bottom: 2px solid rgba(255, 255, 255, 0.12);
  white-space: nowrap;
}
.uploads-table td {
  padding: 0.65rem 1rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  vertical-align: middle;
}
.uploads-table tbody tr:hover {
  background: rgba(255, 255, 255, 0.03);
}
.uploads-table tbody tr.row-alt {
  background: rgba(255, 255, 255, 0.01);
}
.uploads-table tbody tr.row-alt:hover {
  background: rgba(255, 255, 255, 0.04);
}
.expiry-date {
  display: block;
  font-size: 0.75rem;
  color: #52525b;
}
.menu-wrapper {
  position: relative;
  display: inline-block;
}
.meatball-btn {
  padding: 0.3rem 0.6rem;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  color: #71717a;
  cursor: pointer;
  font-size: 1.1rem;
  line-height: 1;
  letter-spacing: 0.05em;
}
.meatball-btn:hover {
  background: rgba(255, 255, 255, 0.06);
  color: #e4e4e7;
  border-color: rgba(255, 255, 255, 0.2);
}
.menu-dropdown {
  z-index: 200;
  background: #1c1c24;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  min-width: 150px;
  padding: 0.25rem;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
}
.menu-item {
  display: block;
  width: 100%;
  padding: 0.45rem 0.75rem;
  font-size: 0.85rem;
  text-align: left;
  background: transparent;
  border: none;
  border-radius: 5px;
  color: #e4e4e7;
  cursor: pointer;
}
.menu-item-link {
  text-decoration: none;
}
.menu-item:hover {
  background: rgba(255, 255, 255, 0.07);
}
.menu-item.danger {
  color: #f87171;
}
.menu-item.danger:hover {
  background: rgba(248, 113, 113, 0.1);
}
.col-url { min-width: 200px; text-align: left; }
.col-date { min-width: 140px; white-space: nowrap; text-align: left; }
.col-expires { min-width: 140px; white-space: nowrap; text-align: left; }
.col-protected { min-width: 80px; text-align: left; }
.data-hint {
  display: block;
  margin-top: 0.25rem;
  font-size: 0.72rem;
  color: #52525b;
}
.data-note {
  margin: 0.75rem 0 0;
  font-size: 0.8rem;
  color: #71717a;
  line-height: 1.5;
}
.uploads-table .col-actions { min-width: 240px; text-align: center; }
.site-title {
  margin: 0 0 0.2rem;
  font-size: 0.9rem;
  font-weight: 600;
  color: #e4e4e7;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.url-link {
  color: #a78bfa;
  text-decoration: none;
  word-break: break-all;
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.url-link:hover {
  text-decoration: underline;
}
.badge {
  display: inline-block;
  padding: 0.2rem 0.5rem;
  border-radius: 4px;
  font-size: 0.8rem;
  font-weight: 500;
}
.badge-yes {
  background: rgba(34, 197, 94, 0.2);
  color: #22c55e;
}
.badge-no {
  background: rgba(255, 255, 255, 0.08);
  color: #71717a;
}
.inline-form {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}
.inline-input {
  padding: 0.35rem 0.5rem;
  font-size: 0.85rem;
  width: 140px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 6px;
  color: #e4e4e7;
}
.inline-input:focus {
  outline: none;
  border-color: rgba(167, 139, 250, 0.5);
}
.inline-select {
  padding: 0.35rem 0.5rem;
  font-size: 0.85rem;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 6px;
  color: #e4e4e7;
}
.inline-select:focus {
  outline: none;
  border-color: rgba(167, 139, 250, 0.5);
}
.inline-error {
  width: 100%;
  margin: 0.25rem 0 0;
  font-size: 0.8rem;
  color: #f87171;
}
.action-btn {
  padding: 0.35rem 0.6rem;
  font-size: 0.8rem;
  background: rgba(167, 139, 250, 0.2);
  border: 1px solid rgba(167, 139, 250, 0.4);
  border-radius: 6px;
  color: #c4b5fd;
  cursor: pointer;
}
.action-btn:hover:not(:disabled) {
  background: rgba(167, 139, 250, 0.3);
}
.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.action-btn.muted {
  background: transparent;
  border-color: rgba(255, 255, 255, 0.2);
  color: #a1a1aa;
}
.action-btn.danger {
  background: rgba(248, 113, 113, 0.15);
  border-color: rgba(248, 113, 113, 0.4);
  color: #f87171;
}
.action-btn.danger:hover:not(:disabled) {
  background: rgba(248, 113, 113, 0.25);
}
.pagination-bar {
  margin-top: 1rem;
  padding: 1rem;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
}
.pagination-info {
  font-size: 0.85rem;
  color: #71717a;
}
.pagination-controls {
  display: flex;
  align-items: center;
  gap: 1rem;
}
.pagination-pages {
  font-size: 0.9rem;
  color: #a1a1aa;
}
.pagination-btn {
  padding: 0.35rem 0.6rem;
  font-size: 0.85rem;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 6px;
  color: #e4e4e7;
  cursor: pointer;
}
.pagination-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.25);
}
.pagination-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.account-card {
  padding: 1.5rem;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  max-width: 420px;
}
.account-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.form-group {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.form-label {
  font-size: 0.85rem;
  color: #a1a1aa;
}
.form-input {
  padding: 0.5rem 0.75rem;
  font-size: 0.95rem;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 8px;
  color: #e4e4e7;
}
.form-input:focus {
  outline: none;
  border-color: rgba(167, 139, 250, 0.5);
}
.form-input:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}
.submit-btn {
  padding: 0.6rem 1rem;
  font-size: 0.95rem;
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
  opacity: 0.6;
  cursor: not-allowed;
}
.form-error {
  margin: 1rem 0 0;
  font-size: 0.9rem;
  color: #f87171;
}
.form-success {
  margin: 1rem 0 0;
  font-size: 0.9rem;
  color: #22c55e;
}
.section-desc {
  margin: 0 0 1rem;
  font-size: 0.9rem;
  color: #a1a1aa;
  line-height: 1.6;
}
.section-desc code {
  font-family: ui-monospace, 'Cascadia Code', Menlo, monospace;
  font-size: 0.85em;
  padding: 0.1em 0.35em;
  background: rgba(255, 255, 255, 0.07);
  border-radius: 4px;
  color: #c4b5fd;
}
.token-create {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.token-reveal {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.token-warning {
  margin: 0;
  font-size: 0.9rem;
  color: #fbbf24;
}
.token-display {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.token-value {
  flex: 1;
  font-family: ui-monospace, 'Cascadia Code', Menlo, monospace;
  font-size: 0.8rem;
  padding: 0.4rem 0.6rem;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 6px;
  color: #c4b5fd;
  overflow-wrap: anywhere;
}
.token-list {
  margin-top: 1rem;
}
.token-row {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.token-row:last-child {
  border-bottom: none;
}
.token-nickname {
  font-weight: 500;
  min-width: 120px;
}
.token-created {
  flex: 1;
  font-size: 0.85rem;
}
.back-link {
  display: inline-block;
  font-size: 0.9rem;
  color: #a1a1aa;
  text-decoration: none;
}
.back-link:hover {
  color: #a78bfa;
}
/* ---------- Data API reference panel ---------- */
.data-api-panel {
  margin: 0 0 1.25rem;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.02);
  overflow: hidden;
}
.data-api-panel__toggle {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  width: 100%;
  padding: 0.85rem 1rem;
  font-size: 0.95rem;
  font-weight: 600;
  color: #e4e4e7;
  background: transparent;
  border: none;
  text-align: left;
  cursor: pointer;
}
.data-api-panel__toggle:hover {
  background: rgba(255, 255, 255, 0.03);
}
.data-api-panel__chevron {
  display: inline-block;
  color: #a78bfa;
  transition: transform 0.15s ease;
}
.data-api-panel__chevron.is-open {
  transform: rotate(90deg);
}
.data-api-panel__meta {
  margin-left: auto;
  font-size: 0.8rem;
  font-weight: 400;
  color: #a1a1aa;
}
.data-api-panel__body {
  padding: 0 1rem 1.15rem;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}
.data-api-panel__lead {
  margin: 1rem 0;
  font-size: 0.9rem;
  line-height: 1.65;
  color: #a1a1aa;
}
.data-api-agent {
  margin: 0 0 1rem;
  padding: 0.8rem;
  background: rgba(167, 139, 250, 0.07);
  border: 1px solid rgba(167, 139, 250, 0.25);
  border-radius: 8px;
}
.data-api-agent__row {
  display: flex;
  align-items: center;
  gap: 0.9rem;
  justify-content: space-between;
  flex-wrap: wrap;
}
.data-api-agent__text {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}
.data-api-agent__text strong {
  color: #e4e4e7;
  font-size: 0.9rem;
}
.data-api-agent__text span {
  font-size: 0.83rem;
  line-height: 1.5;
  color: #a1a1aa;
}
.data-api-agent__error {
  margin: 0.5rem 0 0;
}
.data-api-agent__fallback {
  margin: 0.5rem 0 0;
  padding: 0.7rem;
  font-family: ui-monospace, 'Cascadia Code', Menlo, monospace;
  font-size: 0.78rem;
  line-height: 1.5;
  color: #c4b5fd;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 18rem;
  overflow: auto;
}
.data-api-panel__hint {
  margin: 0 0 1rem;
  font-size: 0.85rem;
  color: #a1a1aa;
}
.data-api-panel__status {
  margin: 0;
  font-size: 0.9rem;
  color: #a1a1aa;
}
.data-api-urls {
  margin: 0 0 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.data-api-url dt {
  margin: 0 0 0.25rem;
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #a1a1aa;
}
.data-api-url dd {
  margin: 0;
}
.data-api-url code {
  font-family: ui-monospace, 'Cascadia Code', Menlo, monospace;
  font-size: 0.85rem;
  padding: 0.35rem 0.6rem;
  display: inline-block;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  color: #c4b5fd;
  word-break: break-all;
}
/* Markdown rendered from docs/jolt-data-api.md */
.data-api-doc {
  max-height: 32rem;
  overflow-y: auto;
  padding-right: 0.5rem;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  padding-top: 1rem;
}
.data-api-doc :deep(h1) {
  font-size: 1.35rem;
  margin: 0 0 0.75rem;
  color: #f4f4f5;
}
.data-api-doc :deep(h2) {
  font-size: 1.05rem;
  font-weight: 600;
  margin: 1.5rem 0 0.5rem;
  padding-bottom: 0.35rem;
  color: #e4e4e7;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.data-api-doc :deep(h3) {
  font-size: 0.95rem;
  font-weight: 600;
  margin: 1.25rem 0 0.4rem;
  color: #d4d4d8;
}
.data-api-doc :deep(p),
.data-api-doc :deep(li) {
  font-size: 0.88rem;
  line-height: 1.7;
  color: #a1a1aa;
}
.data-api-doc :deep(p) {
  margin: 0 0 0.85rem;
}
.data-api-doc :deep(ul),
.data-api-doc :deep(ol) {
  margin: 0 0 0.85rem;
  padding-left: 1.4rem;
}
.data-api-doc :deep(strong) {
  color: #e4e4e7;
}
.data-api-doc :deep(a) {
  color: #a78bfa;
  text-decoration: none;
}
.data-api-doc :deep(a:hover) {
  text-decoration: underline;
}
.data-api-doc :deep(code) {
  font-family: ui-monospace, 'Cascadia Code', Menlo, monospace;
  font-size: 0.8em;
  padding: 0.15em 0.4em;
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 4px;
  color: #c4b5fd;
}
.data-api-doc :deep(pre) {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 0.9rem 1.1rem;
  overflow-x: auto;
  margin: 0 0 0.9rem;
}
.data-api-doc :deep(pre code) {
  background: none;
  border: none;
  padding: 0;
  font-size: 0.82rem;
  color: #d4d4d8;
}
.data-api-doc :deep(table) {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.82rem;
  margin: 0 0 0.9rem;
}
.data-api-doc :deep(th) {
  text-align: left;
  padding: 0.4rem 0.6rem;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #d4d4d8;
  font-weight: 600;
}
.data-api-doc :deep(td) {
  padding: 0.4rem 0.6rem;
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: #a1a1aa;
  vertical-align: top;
}
.data-api-doc :deep(hr) {
  border: none;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  margin: 1.25rem 0;
}
@media (max-width: 640px) {
  .data-api-panel__meta {
    display: none;
  }
}
</style>
