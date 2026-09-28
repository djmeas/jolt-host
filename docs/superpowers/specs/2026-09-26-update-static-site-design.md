# Update an Existing Static Site

## Status
Implemented

## Overview

Let a publisher upload a new iteration of an existing static site without creating another shareable URL. The upload replaces the **entire** published file set; files omitted from the replacement stop being served. Version history and rollback are out of scope.

The site's row, slug, `/view/[slug]` URL, title, password, owner token, `created_at`, and `expires_at` are preserved. Updating content does not restart expiration.

## Agreed behavior

- Accept one `.html`, `.md`, or `.zip` file, as the existing uploader does. A ZIP is the way to submit multiple files.
- Keep the existing upload row, slug, and `/view/[slug]` URL. Preserve its ID, `created_at`, title, password, owner token, and `expires_at`. Updating content does not restart expiration.
- Reject updates to deleted or expired sites; updating cannot revive a site.
- A signed-in user can update a site they own. An admin can update sites through the dashboard. In open publishing mode, a site's owner token can authorize an update. A general-purpose API token alone cannot authorize edits to someone else's site.
- With `REGISTERED_USERS_ONLY=true`, an owner token alone is insufficient: a logged-in user is still required to publish. For an older anonymous upload in that mode, require both a login and its owner token.
- Retain existing password and unlock-link behavior. An update must not issue a new owner token or change site settings.

## Backend

### New endpoint

`PUT /api/uploads/[slug]/content`

**File:** `server/api/uploads/[slug]/content.put.ts`

**Content-Type:** `multipart/form-data`

| Field         | Type   | Required | Description                                                                 |
|---------------|--------|----------|-----------------------------------------------------------------------------|
| `file`        | File   | Yes      | An `.html` file, `.md` file, or `.zip` archive containing the full new site |
| `owner_token` | String | No       | The site's owner token, when ownership is not proven by a login or admin session |

The owner token is accepted **only** as a form field, never in the URL or query string.

**Response (200):**

```json
{
  "slug": "quick-dragon-42",
  "url": "https://your-host.com/view/quick-dragon-42",
  "entry_point": ".content/quick-dragon-42/8f2c.../index.html"
}
```

The saved owner token is never echoed back. The response contains no other settings.

**Errors:**

| Status | Meaning |
|--------|---------|
| 400 | Invalid or unsupported file, unsafe ZIP, CAPTCHA failure, or no file |
| 401 | Not authenticated; in restricted mode, an owner token without a login |
| 403 | Authenticated but not the owner |
| 404 | Site not found or expired |
| 409 | A concurrent update changed the site first |
| 413 | File or expanded ZIP exceeds the size limit |
| 429 | Rate limit exceeded (check `Retry-After`) |

### Authorization (`server/utils/update-auth.ts`)

Authorization is resolved against the **target row**, not the request's general upload credentials:

1. A valid admin session → authorized.
2. Open mode (`REGISTERED_USERS_ONLY` unset): a logged-in user matching `row.user_id`, or a matching owner token → authorized. Otherwise 401 (no login, no token) or 403 (logged in but not the owner).
3. Restricted mode (`REGISTERED_USERS_ONLY=true`): requires a logged-in user **and** either `row.user_id` equals that user or the owner token matches. A token alone → 401. A login alone for a site the user does not own → 403.

An owner token without a login is never sufficient in restricted mode. A matching token together with a login authorizes an older anonymous upload (one with no `user_id`).

### Shared upload rules (`server/utils/upload-content.ts`)

Preparation and validation are shared with `server/api/upload.post.ts` rather than duplicated:

- Accepted filenames: `.html`, `.md`, `.zip`.
- Size policy: per-user limit, then 100MB for API uploads, 5MB for anonymous ZIPs, otherwise `NUXT_JOLTHOST_UPLOAD_MAX_BYTES` (default 25MB).
- ZIP handling rejects any entry that escapes the target directory (including `../` and backslash variants), enforces an uncompressed-size bound, and requires at least one `.html` file.
- The entry point is chosen the same way as at creation: `index.html` at the archive root first, otherwise the first HTML file alphabetically (`pickEntryFile`), including nested paths.

### Safe publication (`server/utils/storage.ts`)

- Each upload is extracted into a unique directory under `storage/.staging/`, outside the served asset root.
- Once validated, the staged directory is moved to `storage/.content/[slug]/[unique-id]/` with `renameSync` so the move is atomic and on the same filesystem.
- Publication is a conditional database update, `updateEntryPointIfUnchanged(slug, expected, next)`:
  - It changes `entry_point` only when the current value still equals the value read before preparation and the row has not expired.
  - The affected-row count is the publication switch. Requests before it use the old files; requests after it use the new files.
  - Zero affected rows → 409 (concurrent update) or 404 (site no longer available). The new files are removed and the existing site stays intact.
- On a successful switch, the former content directory (including the original `storage/[slug]/` layout used by existing uploads) is moved to `storage/.trash/` for a bounded grace period, so an in-flight view request is not interrupted.
- `retireContentPath`, `pruneTrash`, `pruneStaging`, and `reconcileContent` remove abandoned staging and orphaned content after interrupts without deleting the live `entry_point`.

### Deletion and cleanup

`deleteStorageForSlug` removes both the legacy `storage/[slug]/` directory and the replacement `storage/.content/[slug]/` directory. The owner delete, admin delete, and scheduled `cleanup-expired` task all use it, so database deletion and filesystem cleanup stay coordinated. The cleanup task also prunes trash/staging and reconciles orphaned content.

### Caching

`/view/[slug]` sets `Cache-Control: no-store` on the entry page (the `/view/[slug]/` redirect is short-lived) and `/view/[slug]/**` sets `no-cache` on assets, so a refresh of the unchanged URL retrieves the replacement rather than a cached response.

## Frontend

### Dedicated form

`pages/update/[slug].vue` — a replacement form modeled on the uploader:

- File selection for `.html`, `.zip`, or `.md`, with the same client-side validation and CAPTCHA behavior.
- An owner-token field, prefilled from the site's existing `sessionStorage` result entry when present. Credentials are never placed in the route, query string, or shareable link.
- On success, shows and copies the **same** shareable URL. It does not add another My Sites entry or reset the original published date.
- In restricted mode, an anonymous visitor sees a login prompt instead of the form.

### Entry points

- `pages/dashboard/index.vue` — a **"Replace files"** item in each upload row's "⋯" menu, linking to `/update/[slug]`.
- `pages/my-sites.vue` — a "Replace files" link on each saved site card.
- `pages/result/[slug].vue` — a "Replace files" link next to the shareable URL.

## Data

- New uploads: `storage/[slug]/` (unchanged).
- After an update: `storage/.content/[slug]/[generation-id]/`, with the row's `entry_point` pointing at the active generation.
- Retired generations: `storage/.trash/` for a short grace period.
- Abandoned staging: `storage/.staging/`, pruned by the scheduled task.

## Testing

- **Unit:** `server/utils/upload-content.test.ts` (filename/size/entry-point rules and ZIP path-escape rejection), `server/utils/update-auth.test.ts` (authorization matrix), `server/utils/storage.test.ts` (retire/prune/reconcile), `server/utils/db.entry-point.test.ts` (conditional switch, expiry, idempotency).
- **Integration:** `test/integration/upload.test.ts` proves replacement through the original URL without a new row/slug, ZIP asset replacement and 404 for omitted old assets, HTML/Markdown/nested-ZIP entry-point changes, the ownership matrix, invalid/malicious ZIP safety, expiration rejection, concurrent-update 409, and deletion cleanup.
- **Fixtures:** `replacement-site.zip`, `nested-entry-site.zip`, `escape-site.zip` (built by `scripts/build-escape-fixture.mjs`), and `no-html.zip`.
