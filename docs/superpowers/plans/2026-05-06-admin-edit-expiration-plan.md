# Admin Edit Upload Expiration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow admins to set or remove (set to never) the expiration date of any upload from the admin dashboard.

**Architecture:** A new admin API endpoint (`POST /api/admin/upload/:slug/expiration`) wraps the existing `updateExpirationBySlug` utility. The frontend adds a menu item in the uploads table dropdown and a modal dialog matching the existing dark theme.

**Tech Stack:** Nuxt 3 / Vue 3 (Composition API + `<script setup>`), H3 (server routing), existing `updateExpirationBySlug` from `server/utils/db`.

---

## File Structure

- **Create:** `server/api/admin/upload/[slug]/expiration.post.ts` — new admin endpoint
- **Modify:** `pages/admin/index.vue` — add menu item, modal UI, and reactive state

---

## Task 1: Backend — Admin Expiration Endpoint

**File:** Create `server/api/admin/upload/[slug]/expiration.post.ts`

- [ ] **Step 1: Create the endpoint file**

```ts
import { getRouterParam, readBody } from 'h3'
import { requireAdmin } from '~/server/utils/admin-auth'
import { findUploadBySlug, updateExpirationBySlug } from '~/server/utils/db'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const slug = getRouterParam(event, 'slug')
  if (!slug) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }
  const row = findUploadBySlug(slug)
  if (!row) {
    throw createError({ statusCode: 404, message: 'Upload not found' })
  }
  const body = await readBody(event).catch(() => ({}))
  const expiresAtRaw = body?.expiresAt

  let expiresAt: string | null = null
  if (typeof expiresAtRaw === 'string' && expiresAtRaw.trim()) {
    const date = new Date(expiresAtRaw)
    if (isNaN(date.getTime())) {
      throw createError({ statusCode: 400, message: 'Invalid date' })
    }
    expiresAt = date.toISOString()
  }

  updateExpirationBySlug(slug, expiresAt)
  return { ok: true }
})
```

- [ ] **Step 2: Commit**

```bash
git add server/api/admin/upload/[slug]/expiration.post.ts
git commit -m "feat(admin): add POST /api/admin/upload/:slug/expiration endpoint"
```

---

## Task 2: Frontend — Menu Item

**File:** Modify `pages/admin/index.vue`

- [ ] **Step 1: Add "Set expiration" to the uploads menu dropdown**

In the `menu-dropdown` div (around line 469), add a new menu item above the "Delete" line:

```vue
<button type="button" class="menu-item" @click="openExpirationModal(u.slug); openMenuId = null">Set expiration</button>
```

- [ ] **Step 2: Commit**

```bash
git add pages/admin/index.vue
git commit -m "feat(admin): add 'Set expiration' menu item to uploads dropdown"
```

---

## Task 3: Frontend — Modal State

**File:** Modify `pages/admin/index.vue`

- [ ] **Step 1: Add reactive state variables** (add near `editingPassword` ref, around line 87)

```ts
const expirationModalOpen = ref(false)
const expirationModalSlug = ref<string | null>(null)
const expirationNeverExpire = ref(true)
const expirationLoading = ref(false)
const expirationError = ref<string | null>(null)
```

- [ ] **Step 2: Add helper functions** (add near the password functions, around line 107)

```ts
function openExpirationModal(slug: string) {
  expirationModalSlug.value = slug
  expirationNeverExpire.value = true
  expirationLoading.value = false
  expirationError.value = null
  expirationModalOpen.value = true
}

function closeExpirationModal() {
  expirationModalOpen.value = false
  expirationModalSlug.value = null
  expirationNeverExpire.value = true
  expirationLoading.value = false
  expirationError.value = null
}

async function saveExpiration() {
  if (!expirationModalSlug.value) return
  expirationError.value = null
  expirationLoading.value = true
  try {
    await $fetch(`/api/admin/upload/${expirationModalSlug.value}/expiration`, {
      method: 'POST',
      body: { expiresAt: expirationNeverExpire.value ? null : '' },
    })
    closeExpirationModal()
    await refresh()
  } catch (e: unknown) {
    const err = e as { data?: { message?: string }; message?: string }
    expirationError.value = err.data?.message ?? err.message ?? 'Failed to update expiration'
  } finally {
    expirationLoading.value = false
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add pages/admin/index.vue
git commit -m "feat(admin): add expiration modal state and handlers"
```

---

## Task 4: Frontend — Modal UI

**File:** Modify `pages/admin/index.vue`

- [ ] **Step 1: Add the modal markup** (insert before the closing `</template>` tag, around line 375, inside the root `div.page`)

```vue
<!-- Expiration modal -->
<Teleport to="body">
  <div v-if="expirationModalOpen" class="modal-backdrop" @click.self="closeExpirationModal">
    <div class="modal" role="dialog" aria-modal="true">
      <p class="modal-title">Set expiration for <code>{{ expirationModalSlug }}</code></p>
      <div class="modal-body">
        <label class="checkbox-label">
          <input v-model="expirationNeverExpire" type="checkbox" :disabled="expirationLoading" />
          Never expire
        </label>
      </div>
      <p v-if="expirationError" class="modal-error">{{ expirationError }}</p>
      <div class="modal-actions">
        <button type="button" class="modal-cancel" :disabled="expirationLoading" @click="closeExpirationModal">Cancel</button>
        <button type="button" class="modal-confirm" :disabled="expirationLoading" @click="saveExpiration">
          {{ expirationLoading ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </div>
  </div>
</Teleport>
```

- [ ] **Step 2: Add modal CSS** (append to the existing `<style scoped>` block, around line 1373)

```css
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal {
  width: 100%;
  max-width: 380px;
  margin: 1rem;
  background: #1c1c1e;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 14px;
  padding: 1.5rem;
}
.modal-title {
  margin: 0 0 1rem;
  font-size: 1rem;
  font-weight: 600;
  color: #e4e4e7;
}
.modal-title code {
  background: rgba(255, 255, 255, 0.08);
  padding: 0.1rem 0.3rem;
  border-radius: 4px;
  font-size: 0.9rem;
}
.modal-body {
  margin: 0 0 1rem;
  font-size: 0.875rem;
  color: #a1a1aa;
}
.modal-error {
  margin: 0 0 0.75rem;
  font-size: 0.85rem;
  color: #f87171;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.6rem;
}
.modal-cancel {
  padding: 0.45rem 0.9rem;
  font-size: 0.875rem;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 8px;
  color: #a1a1aa;
  cursor: pointer;
}
.modal-cancel:hover:not(:disabled) {
  color: #e4e4e7;
  border-color: rgba(255, 255, 255, 0.3);
}
.modal-cancel:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.modal-confirm {
  padding: 0.45rem 0.9rem;
  font-size: 0.875rem;
  background: rgba(167, 139, 250, 0.2);
  border: 1px solid rgba(167, 139, 250, 0.4);
  border-radius: 8px;
  color: #c4b5fd;
  cursor: pointer;
}
.modal-confirm:hover:not(:disabled) {
  background: rgba(167, 139, 250, 0.3);
}
.modal-confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

- [ ] **Step 3: Commit**

```bash
git add pages/admin/index.vue
git commit -m "feat(admin): add expiration modal UI"
```

---

## Verification

After completing all tasks, verify:

1. Start the dev server: `npm run dev`
2. Log in as admin at `/admin`
3. Go to the **Uploads** tab
4. Click "⋯" on any upload row — confirm "Set expiration" appears in the menu
5. Click "Set expiration" — confirm the modal opens with "Never expire" checked
6. Click "Save" — confirm the modal closes and the uploads table refreshes
7. Change the checkbox to unchecked, click Save — confirm it still works
