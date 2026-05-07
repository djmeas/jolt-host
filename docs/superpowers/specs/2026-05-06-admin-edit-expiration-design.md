# Admin: Edit Upload Expiration Date

## Status
Approved

## Overview
Allow admins to set or remove the expiration date of any upload from the admin dashboard.

## Backend

### New Endpoint
`POST /api/admin/upload/:slug/expiration`

**File:** `server/api/admin/upload/[slug]/expiration.post.ts`

**Auth:** `requireAdmin(event)` — same as other admin endpoints

**Request body:**
```ts
{ expiresAt: string | null }
```
- `string` — ISO datetime (e.g. `"2099-12-31T23:59:59.000Z"`)
- `null` — never expire

**Response:** `{ ok: true }` on success

**Errors:**
- 400 — invalid slug
- 404 — upload not found

**Implementation:** Calls `updateExpirationBySlug(slug, expiresAt)` from `~/server/utils/db` (already exists at line 264).

---

## Frontend

### UI Changes (`pages/admin/index.vue`)

**Menu item:**
- In the uploads table's "⋯" meatball dropdown, add: **"Set expiration"**
- Only admins can see/use this — no additional permission check needed client-side

**Modal (inline component, not a separate page):**
- Triggered by clicking "Set expiration" in the dropdown
- Modal title: "Set expiration for `{slug}`"
- Fields:
  - Checkbox: **"Never expire"** (default: checked if `expires_at` is null, unchecked otherwise)
  - If "Never expire" is unchecked: show a date+time input pre-filled with current expiration date (if set)
- Buttons:
  - **Save** — submits `POST /api/admin/upload/:slug/expiration` with `expiresAt: null` (if never-expire checked) or the ISO string from the picker
  - **Cancel** — closes modal, no changes

**State:**
- `expirationModalOpen: ref<boolean>` — controls modal visibility
- `expirationModalSlug: ref<string | null>` — which upload is being edited
- `expirationNeverExpire: ref<boolean>` — checkbox state
- `expirationLoading: ref<boolean>` — submit in progress

**Behavior:**
- On save success: close modal, call `refresh()` to reload uploads table
- On save error: show inline error message in modal
- On cancel or backdrop click: close modal

---

## Testing Considerations

- Test setting expiration to a specific date
- Test setting expiration to "never" (null)
- Test editing an existing expiration to a different value
- Test removing expiration from an already-never-expire upload
