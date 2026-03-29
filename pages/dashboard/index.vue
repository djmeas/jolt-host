<script setup lang="ts">
type UploadRow = {
  slug: string
  entry_point: string
  created_at: string
  expires_at: string | null
  password_hash: string | null
  user_id: string
}

type UploadsResponse = {
  items: UploadRow[]
  total: number
  page: number
  limit: number
  totalPages: number
}

const { user, isLoggedIn, refresh: refreshUser } = useCurrentUser()

// Auth guard
onMounted(async () => {
  await refreshUser()
  if (!isLoggedIn.value) {
    await navigateTo('/login')
  }
})

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
    uploadsData.value = await $fetch<UploadsResponse>(`/api/user/uploads?page=${uploadsPage.value}&limit=20`)
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
  fetchUploads()
})

const formatDate = (iso: string) => {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function buildUrl(slug: string) {
  if (import.meta.client) {
    return `${window.location.origin}/view/${slug}`
  }
  return `/view/${slug}`
}

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
    await $fetch(`/api/user/uploads/${slug}/password`, {
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
  if (user.value?.never_expire === 1) {
    opts.push({ value: 'never', label: 'Never' })
  }
  return opts
})

function startEditExpiry(slug: string) {
  editingExpirySlug.value = slug
  inlineExpiry.value = '1h'
  expiryError.value = null
}

function computeExpiresAt(val: string): string | null {
  if (val === 'never') return null
  const now = Date.now()
  const map: Record<string, number> = {
    '1h': 1 * 60 * 60 * 1000,
    '8h': 8 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '1w': 7 * 24 * 60 * 60 * 1000,
  }
  return new Date(now + (map[val] ?? 0)).toISOString()
}

async function saveExpiry(slug: string) {
  expirySaving.value = true
  expiryError.value = null
  try {
    const expiresAt = computeExpiresAt(inlineExpiry.value)
    await $fetch(`/api/user/uploads/${slug}/expiration`, {
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

// --- Account settings ---
const currentPassword = ref('')
const newPassword = ref('')
const confirmNewPassword = ref('')
const passwordChangeLoading = ref(false)
const passwordChangeError = ref<string | null>(null)
const passwordChangeSuccess = ref(false)

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
</script>

<template>
  <div class="page">
    <div class="dashboard">
      <div class="header">
        <h1 class="title">Dashboard</h1>
        <span v-if="user" class="header-user">{{ user.name }}</span>
      </div>

      <div class="tabs">
        <button
          type="button"
          class="tab-btn"
          :class="{ active: activeTab === 'uploads' }"
          @click="activeTab = 'uploads'"
        >
          My Uploads
        </button>
        <button
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

        <div v-if="uploadsLoading && !uploadsData" class="empty muted">Loading…</div>

        <div v-else-if="uploads.length === 0 && uploadsData" class="empty muted">
          No uploads yet. <NuxtLink to="/" class="link">Upload your first site</NuxtLink>.
        </div>

        <div v-else-if="uploads.length > 0" class="uploads-section">
          <div class="table-container">
            <table class="uploads-table">
              <thead>
                <tr>
                  <th class="col-url">URL</th>
                  <th class="col-date">Created</th>
                  <th class="col-expires">Expires</th>
                  <th class="col-protected">Password</th>
                  <th class="col-actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(u, idx) in uploads" :key="u.slug" :class="{ 'row-alt': idx % 2 === 1 }">
                  <td class="col-url">
                    <a :href="buildUrl(u.slug)" target="_blank" rel="noopener" class="url-link">
                      {{ buildUrl(u.slug) }}
                    </a>
                  </td>
                  <td class="col-date muted">{{ formatDate(u.created_at) }}</td>
                  <td class="col-expires muted">{{ u.expires_at ? formatDate(u.expires_at) : '—' }}</td>
                  <td class="col-protected">
                    <span :class="['badge', u.password_hash ? 'badge-yes' : 'badge-no']">
                      {{ u.password_hash ? 'Yes' : 'No' }}
                    </span>
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
                        <button type="button" class="action-btn" :disabled="expirySaving" @click="saveExpiry(u.slug)">
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
                      <div class="action-row">
                        <button type="button" class="action-btn" @click="startEditPassword(u.slug)">
                          Change Password
                        </button>
                        <button type="button" class="action-btn" @click="startEditExpiry(u.slug)">
                          Change Expiry
                        </button>
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
        </div>
      </section>

      <!-- Account Settings -->
      <section v-if="activeTab === 'account'" class="section">
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
      </section>

      <NuxtLink to="/" class="back-link">← Back to home</NuxtLink>
    </div>
  </div>
</template>

<style scoped>
.page {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
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
.col-url { min-width: 200px; }
.col-date { min-width: 140px; white-space: nowrap; }
.col-expires { min-width: 140px; white-space: nowrap; }
.col-protected { min-width: 80px; }
.col-actions { min-width: 240px; }
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
.action-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
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
.back-link {
  display: inline-block;
  font-size: 0.9rem;
  color: #a1a1aa;
  text-decoration: none;
}
.back-link:hover {
  color: #a78bfa;
}
</style>
