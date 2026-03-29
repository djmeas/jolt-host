<script setup lang="ts">
type Upload = {
  id: string
  slug: string
  url: string
  entry_point: string
  created_at: string
  expires_at: string | null
  has_password: boolean
}

type UploadsResponse = {
  items: Upload[]
  total: number
  page: number
  limit: number
  totalPages: number
}

type ApiTokenInfo = { id: string; nickname: string; created_at: string }

const page = ref(1)
const dateFrom = ref('')
const dateTo = ref('')
const protectedFilter = ref<'all' | 'yes' | 'no'>('all')

const queryParams = computed(() => ({
  page: page.value,
  dateFrom: dateFrom.value || undefined,
  dateTo: dateTo.value || undefined,
  protected: protectedFilter.value === 'all' ? undefined : protectedFilter.value,
}))

const queryKey = computed(
  () => `admin-uploads-${page.value}-${dateFrom.value}-${dateTo.value}-${protectedFilter.value}`
)

const { data: result, error, refresh } = await useFetch<UploadsResponse>('/api/admin/uploads', {
  query: queryParams,
  key: queryKey,
})

function applyFilters() {
  page.value = 1
}

if (error.value) {
  const statusCode = (error.value as { statusCode?: number }).statusCode
  if (statusCode === 401) {
    await navigateTo('/admin/login')
  } else {
    throw createError({ statusCode: 500, message: 'Failed to load uploads' })
  }
}

const uploads = computed(() => result.value?.items ?? [])
const total = computed(() => result.value?.total ?? 0)
const totalPages = computed(() => result.value?.totalPages ?? 0)
const currentPage = computed(() => result.value?.page ?? 1)
const limit = computed(() => result.value?.limit ?? 20)

const formatDate = (iso: string) => {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

async function logout() {
  await $fetch('/api/admin/logout', { method: 'POST' })
  await navigateTo('/admin/login')
}

async function deletePaste(slug: string) {
  if (!confirm(`Delete ${slug}? This cannot be undone.`)) return
  try {
    await $fetch(`/api/admin/paste/${slug}/delete`, { method: 'POST' })
    await refresh()
  } catch {
    alert('Failed to delete')
  }
}

const editingPassword = ref<string | null>(null)
const newPassword = ref('')

async function updatePassword(slug: string) {
  try {
    await $fetch(`/api/admin/paste/${slug}/password`, {
      method: 'POST',
      body: { password: newPassword.value || null },
    })
    editingPassword.value = null
    newPassword.value = ''
    await refresh()
  } catch {
    alert('Failed to update password')
  }
}

function startEditPassword(slug: string) {
  editingPassword.value = slug
  newPassword.value = ''
}

function goToPage(p: number) {
  page.value = Math.max(1, Math.min(p, totalPages.value))
}

const startItem = computed(() => (currentPage.value - 1) * limit.value + 1)
const endItem = computed(() => Math.min(currentPage.value * limit.value, total.value))

// API tokens
const { data: tokensData, refresh: refreshTokens } = await useFetch<{ tokens: ApiTokenInfo[] }>(
  '/api/admin/tokens',
  { key: 'admin-tokens' }
)
const apiTokens = computed(() => tokensData.value?.tokens ?? [])

const tokenNickname = ref('')
const tokenCreating = ref(false)
const tokenError = ref<string | null>(null)
const newlyCreatedToken = ref<{ token: string; nickname: string } | null>(null)
const tokenCopied = ref(false)

async function createToken() {
  if (!tokenNickname.value.trim()) return
  tokenError.value = null
  tokenCreating.value = true
  newlyCreatedToken.value = null
  try {
    const res = await $fetch<{ token: string; nickname: string }>('/api/admin/tokens', {
      method: 'POST',
      body: { nickname: tokenNickname.value.trim() },
    })
    newlyCreatedToken.value = { token: res.token, nickname: res.nickname }
    tokenNickname.value = ''
    await refreshTokens()
  } catch (e: unknown) {
    const err = e as { data?: { message?: string }; message?: string }
    tokenError.value = err.data?.message ?? err.message ?? 'Failed to create token'
  } finally {
    tokenCreating.value = false
  }
}

function dismissNewToken() {
  newlyCreatedToken.value = null
  tokenCopied.value = false
}

async function copyToken() {
  if (!newlyCreatedToken.value) return
  try {
    await navigator.clipboard.writeText(newlyCreatedToken.value.token)
    tokenCopied.value = true
    setTimeout(() => { tokenCopied.value = false }, 2000)
  } catch {
    tokenError.value = 'Failed to copy to clipboard'
  }
}

async function deleteToken(nickname: string) {
  if (!confirm(`Revoke API token "${nickname}"? This cannot be undone.`)) return
  try {
    await $fetch('/api/admin/tokens/delete', {
      method: 'POST',
      body: { nickname },
    })
    await refreshTokens()
  } catch {
    alert('Failed to delete token')
  }
}

// --- Users ---
type UserRow = {
  id: string
  name: string
  email: string
  upload_max_bytes: number | null
  never_expire: number
  created_at: string
}

type UsersResponse = {
  items: UserRow[]
  total: number
  page: number
  limit: number
  totalPages: number
}

const usersPage = ref(1)
const { data: usersData, refresh: refreshUsers } = await useFetch<UsersResponse>('/api/admin/users', {
  query: computed(() => ({ page: usersPage.value, limit: 20 })),
  key: computed(() => `admin-users-${usersPage.value}`),
})
const users = computed(() => usersData.value?.items ?? [])
const usersTotal = computed(() => usersData.value?.total ?? 0)
const usersTotalPages = computed(() => usersData.value?.totalPages ?? 0)
const usersCurrentPage = computed(() => usersData.value?.page ?? 1)
const usersLimit = computed(() => usersData.value?.limit ?? 20)
const usersStartItem = computed(() => (usersCurrentPage.value - 1) * usersLimit.value + 1)
const usersEndItem = computed(() => Math.min(usersCurrentPage.value * usersLimit.value, usersTotal.value))

function goToUsersPage(p: number) {
  usersPage.value = Math.max(1, Math.min(p, usersTotalPages.value))
}

// Add user form
const showAddUser = ref(false)
const addUserName = ref('')
const addUserEmail = ref('')
const addUserPassword = ref('')
const addUserMaxMb = ref('')
const addUserNeverExpire = ref(false)
const addUserLoading = ref(false)
const addUserError = ref<string | null>(null)

async function createUser() {
  addUserError.value = null
  if (!addUserName.value.trim() || !addUserEmail.value.trim() || !addUserPassword.value) return
  addUserLoading.value = true
  try {
    const body: Record<string, unknown> = {
      name: addUserName.value.trim(),
      email: addUserEmail.value.trim(),
      password: addUserPassword.value,
      never_expire: addUserNeverExpire.value ? 1 : 0,
    }
    if (addUserMaxMb.value.trim()) {
      body.upload_max_bytes = Math.round(parseFloat(addUserMaxMb.value) * 1024 * 1024)
    }
    await $fetch('/api/admin/users', { method: 'POST', body })
    addUserName.value = ''
    addUserEmail.value = ''
    addUserPassword.value = ''
    addUserMaxMb.value = ''
    addUserNeverExpire.value = false
    showAddUser.value = false
    await refreshUsers()
  } catch (e: unknown) {
    const err = e as { data?: { message?: string }; message?: string }
    addUserError.value = err.data?.message ?? err.message ?? 'Failed to create user'
  } finally {
    addUserLoading.value = false
  }
}

// Edit user
const editingUserId = ref<string | null>(null)
const editUserName = ref('')
const editUserEmail = ref('')
const editUserMaxMb = ref('')
const editUserNeverExpire = ref(false)
const editUserLoading = ref(false)
const editUserError = ref<string | null>(null)

function startEditUser(u: UserRow) {
  editingUserId.value = u.id
  editUserName.value = u.name
  editUserEmail.value = u.email
  editUserMaxMb.value = u.upload_max_bytes ? String(Math.round(u.upload_max_bytes / 1024 / 1024)) : ''
  editUserNeverExpire.value = u.never_expire === 1
  editUserError.value = null
}

async function saveEditUser(id: string) {
  editUserError.value = null
  editUserLoading.value = true
  try {
    const body: Record<string, unknown> = {
      name: editUserName.value.trim(),
      email: editUserEmail.value.trim(),
      never_expire: editUserNeverExpire.value ? 1 : 0,
    }
    if (editUserMaxMb.value.trim()) {
      body.upload_max_bytes = Math.round(parseFloat(editUserMaxMb.value) * 1024 * 1024)
    } else {
      body.upload_max_bytes = null
    }
    await $fetch(`/api/admin/users/${id}`, { method: 'PATCH', body })
    editingUserId.value = null
    await refreshUsers()
  } catch (e: unknown) {
    const err = e as { data?: { message?: string }; message?: string }
    editUserError.value = err.data?.message ?? err.message ?? 'Failed to update user'
  } finally {
    editUserLoading.value = false
  }
}

// Reset user password
const resetPasswordUserId = ref<string | null>(null)
const resetPasswordValue = ref('')
const resetPasswordLoading = ref(false)
const resetPasswordError = ref<string | null>(null)

function startResetPassword(id: string) {
  resetPasswordUserId.value = id
  resetPasswordValue.value = ''
  resetPasswordError.value = null
}

async function saveResetPassword(id: string) {
  resetPasswordError.value = null
  if (!resetPasswordValue.value) return
  resetPasswordLoading.value = true
  try {
    await $fetch(`/api/admin/users/${id}/password`, {
      method: 'POST',
      body: { newPassword: resetPasswordValue.value },
    })
    resetPasswordUserId.value = null
    resetPasswordValue.value = ''
  } catch (e: unknown) {
    const err = e as { data?: { message?: string }; message?: string }
    resetPasswordError.value = err.data?.message ?? err.message ?? 'Failed to reset password'
  } finally {
    resetPasswordLoading.value = false
  }
}

async function deleteUser(id: string, name: string) {
  if (!confirm(`Delete user "${name}"? This cannot be undone.`)) return
  try {
    await $fetch(`/api/admin/users/${id}/delete`, { method: 'POST' })
    await refreshUsers()
  } catch {
    alert('Failed to delete user')
  }
}
</script>

<template>
  <div class="page">
    <div class="dashboard">
      <div class="header">
        <h1 class="title">Admin dashboard</h1>
        <button type="button" class="logout-btn" @click="logout">Log out</button>
      </div>

      <section class="section">
        <h2 class="section-title">API tokens</h2>
        <p class="section-desc">Generate tokens for programmatic uploads. Use the header: <code>Authorization: Bearer &lt;token&gt;</code></p>

        <div v-if="newlyCreatedToken" class="token-reveal">
          <p class="token-warning">Copy this token now. It will not be shown again.</p>
          <div class="token-display">
            <code class="token-value">{{ newlyCreatedToken.token }}</code>
            <button type="button" class="copy-token-btn" @click="copyToken">
              {{ tokenCopied ? 'Copied!' : 'Copy' }}
            </button>
          </div>
          <button type="button" class="dismiss-token-btn" @click="dismissNewToken">I've copied it</button>
        </div>

        <div v-else class="token-create">
          <input
            v-model="tokenNickname"
            type="text"
            class="token-nickname-input"
            placeholder="Token nickname (e.g. CI pipeline)"
            :disabled="tokenCreating"
            @keydown.enter="createToken"
          />
          <button
            type="button"
            class="create-token-btn"
            :disabled="!tokenNickname.trim() || tokenCreating"
            @click="createToken"
          >
            {{ tokenCreating ? 'Creating…' : 'Generate token' }}
          </button>
        </div>
        <p v-if="tokenError" class="token-error">{{ tokenError }}</p>

        <div v-if="apiTokens.length > 0" class="token-list">
          <div v-for="t in apiTokens" :key="t.id" class="token-row">
            <span class="token-nickname">{{ t.nickname }}</span>
            <span class="token-created muted">{{ formatDate(t.created_at) }}</span>
            <button type="button" class="action-btn danger" @click="deleteToken(t.nickname)">Revoke</button>
          </div>
        </div>
        <div v-else-if="!newlyCreatedToken" class="token-empty muted">No API tokens yet.</div>
      </section>

      <h2 class="section-title">Uploads</h2>
      <div class="filters">
        <div class="filter-row">
          <div class="filter-group">
            <label for="dateFrom" class="filter-label">From date</label>
            <input
              id="dateFrom"
              v-model="dateFrom"
              type="date"
              class="filter-input"
              @change="applyFilters"
            />
          </div>
          <div class="filter-group">
            <label for="dateTo" class="filter-label">To date</label>
            <input
              id="dateTo"
              v-model="dateTo"
              type="date"
              class="filter-input"
              @change="applyFilters"
            />
          </div>
          <div class="filter-group">
            <label for="protected" class="filter-label">Password protected</label>
            <select
              id="protected"
              v-model="protectedFilter"
              class="filter-select"
              @change="applyFilters"
            >
              <option value="all">All</option>
              <option value="yes">Protected only</option>
              <option value="no">Unprotected only</option>
            </select>
          </div>
          <button type="button" class="filter-btn" @click="applyFilters">Apply filters</button>
        </div>
      </div>

      <div v-if="uploads.length === 0 && result" class="empty">
        No uploads match your filters.
      </div>

      <div v-else-if="uploads.length > 0" class="uploads-section">
        <div class="table-container">
          <table class="uploads-table">
            <thead>
              <tr>
                <th class="col-slug">Slug</th>
                <th class="col-url">URL</th>
                <th class="col-date">Created</th>
                <th class="col-protected">Protected</th>
                <th class="col-expires">Expires</th>
                <th class="col-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(u, idx) in uploads" :key="u.id" :class="{ 'row-alt': idx % 2 === 1 }">
                <td class="col-slug">
                  <code class="slug-cell">{{ u.slug }}</code>
                </td>
                <td class="col-url">
                  <a :href="u.url" target="_blank" rel="noopener" class="url-link" :title="u.url">{{ u.url }}</a>
                </td>
                <td class="col-date muted">{{ formatDate(u.created_at) }}</td>
                <td class="col-protected">
                  <span :class="['badge', u.has_password ? 'badge-yes' : 'badge-no']">
                    {{ u.has_password ? 'Yes' : 'No' }}
                  </span>
                </td>
                <td class="col-expires muted">{{ u.expires_at ? formatDate(u.expires_at) : '—' }}</td>
                <td class="col-actions">
                  <template v-if="editingPassword === u.slug">
                    <input
                      v-model="newPassword"
                      type="password"
                      class="inline-input"
                      placeholder="New password (empty to remove)"
                      @keydown.enter="updatePassword(u.slug)"
                    />
                    <button type="button" class="action-btn" @click="updatePassword(u.slug)">Save</button>
                    <button type="button" class="action-btn muted" @click="editingPassword = null">Cancel</button>
                  </template>
                  <template v-else>
                    <button type="button" class="action-btn" @click="startEditPassword(u.slug)">
                      {{ u.has_password ? 'Change' : 'Set' }}
                    </button>
                    <button type="button" class="action-btn danger" @click="deletePaste(u.slug)">Delete</button>
                  </template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="pagination-bar">
          <span class="pagination-info">
            Showing {{ startItem }}-{{ endItem }} of {{ total }}
          </span>
          <div class="pagination-controls">
            <button
              type="button"
              class="pagination-btn"
              :disabled="currentPage <= 1"
              title="First page"
              @click="goToPage(1)"
            >
              ««
            </button>
            <button
              type="button"
              class="pagination-btn"
              :disabled="currentPage <= 1"
              @click="goToPage(currentPage - 1)"
            >
              ‹ Previous
            </button>
            <span class="pagination-pages">
              Page {{ currentPage }} of {{ totalPages }}
            </span>
            <button
              type="button"
              class="pagination-btn"
              :disabled="currentPage >= totalPages"
              @click="goToPage(currentPage + 1)"
            >
              Next ›
            </button>
            <button
              type="button"
              class="pagination-btn"
              :disabled="currentPage >= totalPages"
              title="Last page"
              @click="goToPage(totalPages)"
            >
              »»
            </button>
          </div>
        </div>
      </div>

      <!-- Users section -->
      <section class="section">
        <div class="section-header-row">
          <h2 class="section-title">Users</h2>
          <button type="button" class="create-token-btn" @click="showAddUser = !showAddUser">
            {{ showAddUser ? 'Cancel' : 'Add user' }}
          </button>
        </div>

        <!-- Add user form -->
        <div v-if="showAddUser" class="add-user-form">
          <div class="add-user-fields">
            <input v-model="addUserName" type="text" class="token-nickname-input" placeholder="Name" :disabled="addUserLoading" />
            <input v-model="addUserEmail" type="email" class="token-nickname-input" placeholder="Email" :disabled="addUserLoading" />
            <input v-model="addUserPassword" type="password" class="token-nickname-input" placeholder="Password" :disabled="addUserLoading" />
            <input v-model="addUserMaxMb" type="number" min="1" class="token-nickname-input" placeholder="Upload limit MB (optional)" :disabled="addUserLoading" style="max-width:200px" />
            <label class="checkbox-label">
              <input v-model="addUserNeverExpire" type="checkbox" :disabled="addUserLoading" />
              Never expire
            </label>
            <button
              type="button"
              class="create-token-btn"
              :disabled="addUserLoading || !addUserName.trim() || !addUserEmail.trim() || !addUserPassword"
              @click="createUser"
            >
              {{ addUserLoading ? 'Creating…' : 'Create user' }}
            </button>
          </div>
          <p v-if="addUserError" class="token-error">{{ addUserError }}</p>
        </div>

        <div v-if="users.length === 0 && usersData" class="token-empty muted">No users yet.</div>

        <div v-else-if="users.length > 0">
          <div class="table-container" style="margin-top:1rem">
            <table class="uploads-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Upload Limit</th>
                  <th>Never Expire</th>
                  <th>Created</th>
                  <th class="col-actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(u, idx) in users" :key="u.id" :class="{ 'row-alt': idx % 2 === 1 }">
                  <!-- Edit inline -->
                  <template v-if="editingUserId === u.id">
                    <td colspan="5">
                      <div class="inline-edit-form">
                        <input v-model="editUserName" type="text" class="inline-input" placeholder="Name" :disabled="editUserLoading" />
                        <input v-model="editUserEmail" type="email" class="inline-input" placeholder="Email" :disabled="editUserLoading" />
                        <input v-model="editUserMaxMb" type="number" min="1" class="inline-input" placeholder="Limit MB (empty=default)" :disabled="editUserLoading" style="width:160px" />
                        <label class="checkbox-label">
                          <input v-model="editUserNeverExpire" type="checkbox" :disabled="editUserLoading" />
                          Never expire
                        </label>
                        <button type="button" class="action-btn" :disabled="editUserLoading" @click="saveEditUser(u.id)">Save</button>
                        <button type="button" class="action-btn muted" @click="editingUserId = null">Cancel</button>
                        <p v-if="editUserError" class="inline-row-error">{{ editUserError }}</p>
                      </div>
                    </td>
                    <td></td>
                  </template>
                  <!-- Reset password inline -->
                  <template v-else-if="resetPasswordUserId === u.id">
                    <td colspan="5">
                      <div class="inline-edit-form">
                        <input
                          v-model="resetPasswordValue"
                          type="password"
                          class="inline-input"
                          placeholder="New password"
                          :disabled="resetPasswordLoading"
                          @keydown.enter="saveResetPassword(u.id)"
                        />
                        <button type="button" class="action-btn" :disabled="resetPasswordLoading || !resetPasswordValue" @click="saveResetPassword(u.id)">Save</button>
                        <button type="button" class="action-btn muted" @click="resetPasswordUserId = null">Cancel</button>
                        <p v-if="resetPasswordError" class="inline-row-error">{{ resetPasswordError }}</p>
                      </div>
                    </td>
                    <td></td>
                  </template>
                  <!-- Normal row -->
                  <template v-else>
                    <td>{{ u.name }}</td>
                    <td class="muted">{{ u.email }}</td>
                    <td class="muted">{{ u.upload_max_bytes ? `${Math.round(u.upload_max_bytes / 1024 / 1024)} MB` : 'Default' }}</td>
                    <td>
                      <span :class="['badge', u.never_expire ? 'badge-yes' : 'badge-no']">
                        {{ u.never_expire ? 'Yes' : 'No' }}
                      </span>
                    </td>
                    <td class="muted">{{ formatDate(u.created_at) }}</td>
                    <td class="col-actions">
                      <div class="actions">
                        <button type="button" class="action-btn" @click="startEditUser(u)">Edit</button>
                        <button type="button" class="action-btn" @click="startResetPassword(u.id)">Reset PW</button>
                        <button type="button" class="action-btn danger" @click="deleteUser(u.id, u.name)">Delete</button>
                      </div>
                    </td>
                  </template>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="pagination-bar">
            <span class="pagination-info">
              Showing {{ usersStartItem }}–{{ usersEndItem }} of {{ usersTotal }}
            </span>
            <div class="pagination-controls">
              <button type="button" class="pagination-btn" :disabled="usersCurrentPage <= 1" title="First page" @click="goToUsersPage(1)">««</button>
              <button type="button" class="pagination-btn" :disabled="usersCurrentPage <= 1" @click="goToUsersPage(usersCurrentPage - 1)">‹ Previous</button>
              <span class="pagination-pages">Page {{ usersCurrentPage }} of {{ usersTotalPages }}</span>
              <button type="button" class="pagination-btn" :disabled="usersCurrentPage >= usersTotalPages" @click="goToUsersPage(usersCurrentPage + 1)">Next ›</button>
              <button type="button" class="pagination-btn" :disabled="usersCurrentPage >= usersTotalPages" title="Last page" @click="goToUsersPage(usersTotalPages)">»»</button>
            </div>
          </div>
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
.logout-btn {
  padding: 0.4rem 0.75rem;
  font-size: 0.9rem;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 6px;
  color: #a1a1aa;
  cursor: pointer;
}
.logout-btn:hover {
  color: #e4e4e7;
  border-color: rgba(255, 255, 255, 0.35);
}
.section {
  margin-bottom: 2rem;
}
.section-title {
  margin: 0 0 0.5rem;
  font-size: 1.1rem;
  font-weight: 600;
}
.section-desc {
  margin: 0 0 1rem;
  font-size: 0.85rem;
  color: #a1a1aa;
}
.section-desc code {
  background: rgba(255, 255, 255, 0.08);
  padding: 0.15rem 0.4rem;
  border-radius: 4px;
  font-size: 0.8rem;
}
.token-reveal {
  padding: 1rem;
  background: rgba(34, 197, 94, 0.08);
  border: 1px solid rgba(34, 197, 94, 0.3);
  border-radius: 8px;
  margin-bottom: 1rem;
}
.token-warning {
  margin: 0 0 0.75rem;
  font-size: 0.9rem;
  color: #22c55e;
  font-weight: 500;
}
.token-display {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 0.75rem;
}
.token-value {
  flex: 1;
  min-width: 200px;
  padding: 0.5rem 0.75rem;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 6px;
  font-size: 0.85rem;
  word-break: break-all;
}
.copy-token-btn {
  padding: 0.4rem 0.75rem;
  font-size: 0.85rem;
  background: rgba(34, 197, 94, 0.2);
  border: 1px solid rgba(34, 197, 94, 0.5);
  border-radius: 6px;
  color: #22c55e;
  cursor: pointer;
}
.copy-token-btn:hover {
  background: rgba(34, 197, 94, 0.3);
}
.dismiss-token-btn {
  padding: 0.35rem 0.6rem;
  font-size: 0.85rem;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 6px;
  color: #a1a1aa;
  cursor: pointer;
}
.dismiss-token-btn:hover {
  color: #e4e4e7;
  border-color: rgba(255, 255, 255, 0.35);
}
.token-create {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-bottom: 0.5rem;
}
.token-nickname-input {
  flex: 1;
  min-width: 180px;
  padding: 0.4rem 0.6rem;
  font-size: 0.9rem;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 6px;
  color: #e4e4e7;
}
.token-nickname-input:focus {
  outline: none;
  border-color: rgba(167, 139, 250, 0.5);
}
.create-token-btn {
  padding: 0.4rem 0.75rem;
  font-size: 0.9rem;
  background: rgba(167, 139, 250, 0.2);
  border: 1px solid rgba(167, 139, 250, 0.4);
  border-radius: 6px;
  color: #c4b5fd;
  cursor: pointer;
}
.create-token-btn:hover:not(:disabled) {
  background: rgba(167, 139, 250, 0.3);
}
.create-token-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.token-error {
  margin: 0 0 1rem;
  font-size: 0.9rem;
  color: #f87171;
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
.token-empty {
  margin-top: 0.5rem;
  font-size: 0.9rem;
}
.filters {
  margin-bottom: 1.5rem;
  padding: 1rem;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 10px;
}
.filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  align-items: flex-end;
}
.filter-group {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.filter-label {
  font-size: 0.8rem;
  color: #a1a1aa;
}
.filter-input,
.filter-select {
  padding: 0.4rem 0.6rem;
  font-size: 0.9rem;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 6px;
  color: #e4e4e7;
  min-width: 140px;
}
.filter-input:focus,
.filter-select:focus {
  outline: none;
  border-color: rgba(167, 139, 250, 0.5);
}
.filter-btn {
  padding: 0.4rem 0.75rem;
  font-size: 0.9rem;
  background: rgba(167, 139, 250, 0.2);
  border: 1px solid rgba(167, 139, 250, 0.4);
  border-radius: 6px;
  color: #c4b5fd;
  cursor: pointer;
}
.filter-btn:hover {
  background: rgba(167, 139, 250, 0.3);
}
.empty {
  padding: 2rem;
  text-align: center;
  color: #71717a;
  margin-bottom: 1.5rem;
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
.col-slug { min-width: 120px; }
.col-url { min-width: 180px; }
.col-date { min-width: 140px; white-space: nowrap; }
.col-protected { min-width: 85px; }
.col-expires { min-width: 140px; white-space: nowrap; }
.col-actions { min-width: 160px; }
.slug-cell {
  font-size: 0.85rem;
  background: rgba(255, 255, 255, 0.06);
  padding: 0.2rem 0.4rem;
  border-radius: 4px;
  word-break: break-all;
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
.muted {
  color: #71717a;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}
.inline-input {
  padding: 0.35rem 0.5rem;
  font-size: 0.85rem;
  width: 160px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 6px;
  color: #e4e4e7;
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
.action-btn:hover {
  background: rgba(167, 139, 250, 0.3);
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
.action-btn.danger:hover {
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
.back-link {
  display: inline-block;
  font-size: 0.9rem;
  color: #a1a1aa;
  text-decoration: none;
}
.back-link:hover {
  color: #a78bfa;
}
.section-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.75rem;
}
.section-header-row .section-title {
  margin: 0;
}
.add-user-form {
  padding: 1rem;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  margin-bottom: 1rem;
}
.add-user-fields {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}
.checkbox-label {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.9rem;
  color: #a1a1aa;
  cursor: pointer;
  white-space: nowrap;
}
.checkbox-label input[type="checkbox"] {
  accent-color: #a78bfa;
  width: 14px;
  height: 14px;
}
.inline-edit-form {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
  padding: 0.25rem 0;
}
.inline-row-error {
  width: 100%;
  margin: 0.25rem 0 0;
  font-size: 0.8rem;
  color: #f87171;
}
</style>
