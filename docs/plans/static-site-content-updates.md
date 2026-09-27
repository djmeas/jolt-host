# Update an existing static site

## Goal

Let a publisher upload a new iteration of an existing static site without creating another shareable URL. The upload replaces the **entire** published file set; files omitted from the replacement must stop being served. Version history and rollback are out of scope.

## Agreed behavior

- Accept one `.html`, `.md`, or `.zip` file, as the existing uploader does. A ZIP is the way to submit multiple files.
- Keep the existing upload row, slug, and `/view/[slug]` URL. Preserve its ID, `created_at`, title, password, owner token, and `expires_at`. Updating content does not restart expiration.
- Reject updates to deleted or expired sites; updating cannot revive a site.
- A signed-in user can update a site they own. An admin can update sites through the dashboard. In open publishing mode, a site's owner token can authorize an update. A general-purpose API token alone cannot authorize edits to someone else's site.
- With `REGISTERED_USERS_ONLY=true`, an owner token alone is insufficient: a logged-in user is still required to publish. For an older anonymous upload in that mode, require both a login and its owner token.
- Retain existing password and unlock-link behavior. An update must not issue a new owner token or change site settings.

## Existing flow and files

- `server/api/upload.post.ts` checks publishing authorization, rate limits, CAPTCHA, file types and size, then writes HTML/Markdown or extracts a ZIP and inserts an `uploads` row.
- `server/utils/db.ts` stores the slug and `entry_point`. `server/routes/view/[slug].get.ts` serves that entry point; `server/routes/view/[slug]/[...path].get.ts` resolves assets relative to its directory. A conditional change to `entry_point` can therefore switch the published content without changing the URL.
- `server/utils/storage.ts`, `server/tasks/cleanup-expired.ts`, and the owner/admin delete routes remove stored files.
- `pages/dashboard/index.vue` lists registered-user and admin uploads. `pages/my-sites.vue` and `composables/useMySites.ts` track sites in localStorage but **do not** retain owner tokens. `pages/result/[slug].vue` holds the token in sessionStorage after creation.
- `test/integration/upload.test.ts` exercises the running server and is the best place to prove the update flow.

## Implementation tasks

### 1. Define authorization and the update API

- [x] Add `PUT /api/uploads/[slug]/content` in `server/api/uploads/[slug]/content.put.ts`. Accept `multipart/form-data` with a `file` and optional `owner_token` field; do not accept the token in the URL.
- [x] Find the target row and authorize against **that row**: matching `user_id`, admin session, or matching owner token under the publishing-mode rule above. A web upload session or API token is not ownership proof. Apply the existing upload rate limit, size policy, and CAPTCHA policy; an API token can retain its existing CAPTCHA exemption only when the request also proves ownership.
- [x] Validate the filename and uploaded bytes using the same accepted formats and limits as creation. For ZIPs, validate member paths, reject entries that escape the target directory (including unsafe links), enforce an extraction-size bound, and find the HTML entry point before publication. Extract into an isolated directory, never directly over live files. Where practical, share preparation and validation with `server/api/upload.post.ts` rather than maintaining two divergent upload rules.
- [x] Return the unchanged `slug` and `url` plus the new `entry_point`. Do not expose the saved owner token in an update response. Use clear errors for invalid files (400), unauthenticated requests (401), insufficient ownership (403), missing/expired sites (404), conflicting concurrent updates (409), oversized files (413), and rate limiting (429).

### 2. Publish the replacement safely

- [x] Stage each complete upload under a unique path outside the currently served asset root. Once validated, move it to a unique permanent content directory, such as `storage/.content/[slug]/[unique-id]/`. Keep staging and published content on the same filesystem so the move can be atomic.
- [x] Add a database operation that changes `entry_point` on the **existing** row only if its value still equals the value read before preparation and the row has not expired. Check the affected-row count. The database pointer change is the publication switch: requests before it use the old files; requests after it use the new files.
- [x] On validation or publish failure, remove only the new files and keep the existing site intact. On a successful switch, retire the former content, including the original `storage/[slug]/` layout used by existing uploads. Avoid deleting files still needed by an in-flight view request; prune retired files after a short grace period or another bounded cleanup mechanism. Remove abandoned staging and orphaned content after interrupted operations without deleting the current `entry_point`.
- [x] Update `server/utils/storage.ts` and every deletion path (owner delete, admin delete, scheduled expiration cleanup) to remove both legacy and replacement content for a slug. Coordinate database deletion and filesystem cleanup so a concurrent update cannot restore a deleted site.
- [x] Check cache headers on both view routes so a refresh of the unchanged URL retrieves the replacement rather than a cached entry page or asset.

### 3. Add the browser flow

- [x] Add a “Replace files” action to eligible uploads in `pages/dashboard/index.vue`, plus links from `pages/my-sites.vue` and `pages/result/[slug].vue` to a dedicated `/update/[slug]` form.
- [x] Let an anonymous owner enter the original owner token. The result page may prefill it from its existing sessionStorage entry. Do not put credentials in the route, query string, or shareable link. Account owners should not need to find a token.
- [x] Match the uploader's file selection, format guidance, loading/error feedback, and CAPTCHA behavior. After success, show and copy the **same** shareable URL. Do not add another My Sites entry or reset its original published date.

### 4. Verify and document

- [x] Extend `test/integration/upload.test.ts` to create a site, replace it, and fetch the **original URL** to prove the new content is live without another database row or slug.
- [x] Verify ZIP replacement serves new assets and returns 404 for omitted old assets; cover HTML, Markdown, and ZIP entry-point changes, including nested ZIP entry points.
- [x] Verify title, password/unlock access, owner token, creation date, and expiration deadline remain unchanged, and expired sites cannot be updated.
- [x] Verify registered ownership, anonymous owner-token access, restricted-mode login requirements, admin access, API-token-only rejection, and invalid/missing tokens.
- [x] Verify invalid/oversized ZIPs and conflicting updates leave the previous publication usable. Verify deletion and expiration cleanup remove updated content.
- [x] Document the endpoint, full-replacement semantics, permissions, and stable URL in `README.md` and `docs/how-to-use-upload-endpoint.md`. Run the relevant unit and integration suites (`npm run test:unit` and `npm run test:integration`).

## Completion criteria

A publisher can replace a site's complete file set and immediately load the new content and assets through its original `/view/[slug]` URL. Missing old assets disappear, existing settings and expiration remain intact, unauthorized updates fail, and a failed replacement leaves the previous site working.
