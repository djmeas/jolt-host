# AI Builder: vibe-code a static site in Jolt Host

> **Executor:** This is the complete implementation specification, including phase 6 (editing an existing upload). Implement all six phases as one release. Do not replace code generation with an agent, execute generated code on the server, introduce BYOK, duplicate publishing policy, or omit existing-site editing. Read live files before editing; preserve existing upload clients. Do not commit, push, or open a PR unless instructed.
>
> **Drift check first:** `git rev-parse --short HEAD`; `git diff --stat 707f1dc..HEAD -- server components composables pages test package.json package-lock.json README.md .env.example docs nuxt.config.ts docker-compose.yml`; `git diff --stat -- server components composables pages test package.json package-lock.json README.md .env.example docs nuxt.config.ts docker-compose.yml`. Compare changes against the verified current-state references below. Do not overwrite another contributor's work. Resolve changed auth/storage invariants before implementation.

## Status

- Status: definitive implementation plan; **not implemented or runtime-verified**.
- Priority: P1; implementation risk: HIGH (operator-paid external requests, private workspace files, publishing and ownership races).
- Category: direction / security / migration.
- Planned against: commit `707f1dc` (`707f1dc71c2e5504a4788bd52877787d65f73330`), 2026-10-01.
- Dependencies: the existing isolated-origin hosting and full-content-replacement implementations already present at this commit. Their historical plans are context, not instructions to reimplement them.
- Planning deliverable changes only this document. The Scope section below describes the **future implementation**, not authorization to edit those files during plan refinement.

## Why

A signed-in user should be able to describe a static site in Jolt's own upload box, inspect the generated text files, describe changes, and publish through Jolt's existing hosting pipeline. One model response is data, not an executable agent action. The operator pays for a server-side OpenCode/OpenAI-compatible model connection; users never supply or receive its credentials.

A new-site preview is already a real publication, not a private sandbox. Existing-site editing is different: seed the user's workspace from an owned upload, preserve opaque assets, and explicitly replace that upload through its original URL. Neither path runs generated HTML, JavaScript, shell commands, package installation, or build tools on the server.

## Current state / conventions (verified at planned-at commit)

All references in this section describe existing code, not proposed files.

- `server/api/upload.post.ts:21-34,41-187`: `parseExpirationToISO` and the creation handler. The handler starts at **41**, authorizes at 42, consumes the existing upload rate limit at 44-57, checks Turnstile at 63-69, parses password/data/expiration/title at 77-116, resolves account attribution and `never_expire` at 118-123, checks file format/size at 125-141, verifies the canonical URL before persistence at 148-156, writes at 158-166, inserts the row at 168, and returns the standard result at 170-187. `enable_data` validation occurs at 83-104 before persistence. It returns `owner_token` separately and optionally `url_with_unlock`; there is no `url_with_owner_token` response.
- **Logged-in is not a CAPTCHA exemption.** Creation's `if (!hasValidApiToken(event))` at `server/api/upload.post.ts:63-69` applies to signed-in users too. `server/api/uploads/[slug]/content.put.ts:86-93` has the same policy. Builder publication must pass the current Turnstile token when enabled, not invent an internal exemption.
- `server/utils/upload-auth.ts:11-52`: bearer API tokens, upload attribution, and registered/open-mode authorization. `resolveUploadUserId` prefers the logged-in user. `server/utils/user-auth.ts:35-54` verifies/reads the registered-user cookie; `requireUser` alone does **not** check that the user row still exists. Every builder request must also use `findUserById`.
- `server/utils/update-auth.ts:27-57`: replacement permits admin, matching registered ownership, or owner-token authorization under existing publishing-mode rules. AI attachment is deliberately narrower: registered user plus matching `user_id`, or that registered user also has an admin session; never owner-token attachment.
- `server/utils/upload-content.ts:8-29,32-107,110-122`: accepted incoming upload formats are `.html`, `.zip`, `.md`, not the AI editable-file extensions. `resolveUploadMaxBytes` gives an account override precedence, otherwise API ZIPs can be 100 MiB and web ZIPs 5 MiB. ZIP extraction is limited to 100 MiB uncompressed and requires an HTML entry. The private ZIP path normalizer at 45-50 strips leading slashes and replaces backslashes; do **not** copy that leniency into model-manifest validation. Containment checks at 69-78 are useful, but AI paths must reject rather than rewrite unsafe names.
- `server/api/uploads/[slug]/content.put.ts:36-164`: replacement checks site existence/expiration, rate limits, ownership, canonical URL, CAPTCHA, format/size; stages at 117-125, renames into a generation at 127-135, conditionally changes the DB pointer at 138-150, and retires prior content at 153-159. `server/utils/db.ts:135-148` implements `UPDATE uploads SET entry_point = ? WHERE slug = ? AND entry_point = ? AND ...unexpired...`. Preserve that conflict behavior and all other row fields.
- `server/utils/storage.ts:6-23,41-149`: `.content`, `.staging`, `.trash`, five-minute retirement grace, generation publication and reconciliation. These are **upload** lifecycle helpers, not an existing workspace API.
- `server/utils/site-host.ts:368-397,405-438`: static serving uses realpath containment and resolves assets relative to **`dirname(storage/entry_point)`**, not necessarily the original ZIP root or generation root. This distinction is essential when attaching a nested-entry upload. `server/middleware/site-host.global.ts:24-79` dispatches hosted requests to site content and blocks app APIs; `server/utils/site-host.ts:318-353` defines blocked app paths and Jolt-owned hosted paths. No workspace path is currently a published entry point. Keep it that way.
- `server/utils/site-host.ts:300-312`: `requireExactOrigin` already implements cookie-mutation origin checking, accepting the exact expected origin or, only when Origin is missing/null, `Sec-Fetch-Site: same-origin`. Reuse this behavior with the configured **app** origin for AI mutations; do not create permissive CORS.
- `server/utils/db.ts:5-10,19-28,30-82`: normal storage is `storage`, DB is `data/jolt.db`; test mode uses `test/tmp-storage` and `test/tmp-data/jolt.db`. Tables use `CREATE TABLE IF NOT EXISTS`; existing columns migrate through `addColumnIfMissing`. `data_enabled` is added at 50; data enable/disable helpers are at 188-204. New AI tables belong here.
- `server/api/config.get.ts:1-13` returns `dataFeatureAvailable` and `dataApiToggleEnabled`. `server/utils/upload-mode.ts:9-12` uses `process.env.ENABLE_DATA_API_TOGGLE !== 'false'`; follow that exact false-string convention for the AI switch.
- `server/utils/rate-limit.ts:9-12,25-47`: process-local sliding-window upload limiter, 25 requests/IP/hour. `server/utils/site-rate-limit.ts:20-68` demonstrates bounded buckets, pruning, and `Retry-After`. AI chat uses a **separate user-ID budget**, not a renamed upload budget.
- `pages/index.vue:4-9,21,29-36,57-65,132-181,208-211,264-400`: config/current user, minimal-landing decision, sign-in notice, Turnstile lifecycle, result sessionStorage, upload submission, and the hero `.box`. Add tabs inside that existing hero box. Existing `.form-options` styling begins at 668.
- `pages/dashboard/index.vue:24-32,44-53,113-116,522-580,684-711`: user/admin session distinction, list fetch, replacement navigation, panel convention, and per-upload menu. Existing list routes are `server/api/user/uploads.get.ts:6-25` and `server/api/admin/uploads.get.ts:6-35`; they map existing row fields plus canonical URL. Add only the eligibility information needed by the builder; never add owner-token query links.
- `server/api/admin/users/[id]/delete.post.ts:5-19` deletes users through `deleteUser`; `server/utils/db.ts:462-467` currently removes account API tokens and the account row. Account deletion must also remove AI rows/files and prevent an in-flight generation from recreating them.
- `server/tasks/cleanup-expired.ts:16-40` deletes/reconciles upload content and per-site databases. `nuxt.config.ts:80-82` schedules it every 15 minutes. Do **not** add workspace TTL to this task in the MVP.
- `docker-compose.yml:8-11` mounts `/app/data` and `/app/storage`; workspaces ride the existing storage volume. No new volume or container is required.
- `package.json:6-15` defines `npm run build`, `npm run dev`, `npm run test:unit`, `npm run test:integration`, and `npm run test:composables`. `archiver` currently appears only in **devDependencies** at 26-30; `scripts/build-test-fixtures.mjs:6-25` demonstrates ZIP construction. Server ZIP creation requires moving the existing `archiver` dependency to dependencies and updating the lockfile; do not rely on development-only installation.
- `test/setup-integration.mjs:15-32,35-76` builds once and starts real Nitro with runtime-only origins, `JOLT_TEST_MODE=1`, and `REGISTERED_USERS_ONLY=true`; the default minimal landing is intentional. `test/integration/upload.test.ts:54-104,145-173,182-219` supplies raw hosted-Host requests, hosted helpers, same-file cleanup, and real account/admin login. Extend **that same file**. `vitest.integration.config.ts:14-20` uses this global setup. `vitest.config.ts:17-21` serializes unit files sharing one SQLite fixture.

## Contract to implement (no open product decisions)

### 1. Locked operator decisions

The following behavior is fixed; the implementation details below must not weaken it:

- **Codegen-only MVP: NO agent runtime, NO shell, NO containers in v1. One chat turn = one LLM call = one validated JSON file manifest (paths + contents) applied to a per-user workspace. Iteration = follow-up patch turns.**
- **Operator-supplied key, server-side only (operator's OpenCode API key, OpenAI-compatible chat-completions endpoint via JOLT_AI_BASE_URL / JOLT_AI_API_KEY / JOLT_AI_MODEL). No BYOK in MVP. Feature fails closed without key: no UI, endpoints 503. ENABLE_AI_BUILDER env kill-switch, default true when key configured (convention like ENABLE_DATA_API_TOGGLE).**
- **One workspace per user at storage/.workspaces/<user-id>/ (never served; rides existing docker volume). Persists across logins; TTL cleanup deferred.**
- **Text-only generated files (.html .css .js .md .txt .svg .json); no binaries generated. Caps: 50 files, 5 MiB total workspace, 1 MiB/file.**
- **Preview = publish: package workspace as ZIP through the same creation pipeline as server/api/upload.post.ts (extract shared helper rather than duplicating; lesson from docs/plans/static-site-content-updates.md). Each preview = new real upload owned by the signed-in user.**
- **UI entry: Build tab in the landing-page upload box (pages/index.vue hero box), tab strip Upload | Build; components/AiBuilder.vue; hidden when unavailable; sign-in notice when logged out in restricted mode; dashboard keeps secondary deep link, no new route.**
- **Phase 6 (operator added): Edit an EXISTING upload — attach a site the user owns (user_id match or admin; anonymous owner-token sites excluded), seed workspace from the live generation, chat/patch, publish via PUT /api/uploads/[slug]/content replacement semantics (same URL/slug; expiration, password, data_enabled, records untouched). Design choice: carry opaque/binary files through as non-editable (model never sees them, manifests cannot modify/delete them, publish includes them); attach refuses sites exceeding editable-text caps with a clear error. Include a local "restore previous version" snapshot per edit session (.pre-edit-<timestamp>/ in workspace).**
- **Abuse guards: per-user message rate limit (in-memory, convention from server/utils/rate-limit.ts / site-rate-limit.ts), one in-flight generation per user (409), per-turn LLM response byte cap, chat body cap ~8 KiB, message content truncation before DB insert (16 KiB).**
- **Cost visibility from day one: ai_messages table records model, input/output tokens, duration per turn.**

The 50-file/5-MiB/1-MiB limits apply to the active editable/generated file set. Phase 6's deliberately retained opaque assets are not generated files and are accounted separately, bounded by the existing upload/archive limits. Snapshot, staging, and generation metadata are private implementation storage, not additional user files or model context. Do not claim a 5-MiB physical disk ceiling while retaining snapshots and opaque assets; document the distinction explicitly.

### 2. Configuration and availability

Read secrets only in server code, at runtime:

| Variable | Exact behavior |
| --- | --- |
| `JOLT_AI_API_KEY` | Operator's nonblank bearer key. Never returned, logged, stored in AI messages, included in prompts, or put into public runtime config. |
| `JOLT_AI_BASE_URL` | Explicit OpenAI-compatible API base, e.g. the operator's documented gateway URL ending in `/v1`; append `/chat/completions` once. Require absolute HTTPS, except loopback HTTP for local/mock use. Reject URL userinfo, query, and fragment. Do not silently select a guessed OpenCode gateway address. |
| `JOLT_AI_MODEL` | Explicit nonblank provider model identifier. No hardcoded guessed model. |
| `ENABLE_AI_BUILDER` | Disabled only by the literal string `false`; otherwise enabled when the required configuration is valid. |

`aiBuilderAvailable()` returns a boolean: false if the key is missing/blank, the kill-switch is false, or the base/model configuration is missing/invalid. Missing key always fails closed. `GET /api/config` adds exactly `aiBuilderAvailable: boolean`, keeping all existing fields. It reveals no key, endpoint URL, model, configuration failure reason, or usage.

All `/api/ai/**` endpoints and the AI-workspace mode of content replacement check availability **before** auth/body parsing and return 503 when unavailable. Ordinary upload/replacement remains available under its existing policy. Availability does not allocate a workspace or call the provider.

A real gateway's supported model/context limit is a deployment prerequisite, not a fact verified by this repository. The operator must configure their actual compatible base/model; a failed request must never fall back to another provider or model.

### 3. Authentication, private responses, and fixed bounds

- Every AI request requires a valid registered-user session **and an existing user row**, in open as well as restricted publishing mode. Anonymous web sessions, bearer upload tokens, view cookies, owner tokens, and admin-only sessions do not allocate a workspace. An admin editing another user's site must also be signed in to a registered account; the workspace belongs to that signed-in account.
- Derive the workspace user ID solely from that verified account. Reject client `user_id`, workspace roots, generation paths, credentials, model selection, and arbitrary target URLs.
- Mutations require the existing origin check against the configured app origin and same-origin fetch behavior described above. Hosted-origin `/api/ai/**` remains 404 through the existing dispatcher. No credentialed CORS.
- Set `Cache-Control: no-store` on all AI responses. File reads are JSON/plain data, never HTML rendering on the app origin. Render message/summary/file text with Vue interpolation or `textContent`, never `v-html`, `srcdoc`, or app-origin generated-content previews.
- Chat JSON body maximum: **8,192 UTF-8 bytes before parsing**, including envelope, not JavaScript string length. Reuse `readBoundedJson(event, 8192)` and `requireJsonContentType`. The same JSON bound applies to the new small workspace/preview controls.
- User message: nonempty after trimming; no automatic semantic rewriting. Stored content for every `ai_messages` insert/update is UTF-8-truncated to **16,384 bytes**, preserving valid code points. Do not truncate the incoming model manifest to make it valid.
- Chat rate limit: **30 accepted generation attempts/user/rolling hour**, separate from upload limits; failed provider attempts consume the budget. Invalid body, stale revision, or already-busy requests do not consume it or call the provider. Return 429 with integer `Retry-After` seconds. Follow bounded 10,000-bucket/prune conventions; full live map refuses new buckets rather than growing unboundedly.
- One in-flight generation/user; use a process-local user operation guard. All workspace mutations and publication preparation use the same guard and return 409 while busy, so attach/restore/reset cannot race a chat. Different users remain independent. Release in `finally`, including cancellation/error cases. This is a single-Nitro-process MVP, not a distributed-lock design.
- LLM timeout: **60 seconds**, covering connection and response consumption, with abort. No automatic retry, second repair call, streaming, tools, or agent loop.
- LLM response maximum: **8 MiB decoded response-body bytes**, including the OpenAI envelope; enforce while reading and abort on overflow, regardless of Content-Length. Parse only after the bound is satisfied.
- Send `max_tokens: 32768`, `stream: false`, `n: 1`. Accept only one textual assistant completion with `finish_reason: "stop"`; truncated completions, tool calls, malformed envelopes and non-JSON manifests fail without workspace mutation. If a configured provider cannot support this request contract, report configuration incompatibility rather than silently changing the protocol.
- Usage values are provider-reported, nonnegative safe integers or null when absent. Never invent token counts or prices. Measure duration with a monotonic clock around the external call/response read, in integer milliseconds. Record the returned model when a usable string is supplied, otherwise the requested model.

### 4. Exact additive database schema

Add the following DDL to `server/utils/db.ts` after `users` exists. Use bound statements for all values and existing getDb/test path conventions. Foreign-key declarations document relationships; explicit account cleanup is required because this feature must not rely on an unverified connection-level foreign-key pragma.

```sql
CREATE TABLE IF NOT EXISTS ai_workspaces (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  current_generation TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  entry_file TEXT NOT NULL DEFAULT 'index.html',
  attached_upload_id TEXT,
  attached_slug TEXT,
  attached_entry_point TEXT,
  snapshot_dir TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (attached_upload_id IS NULL AND attached_slug IS NULL
      AND attached_entry_point IS NULL AND snapshot_dir IS NULL)
    OR
    (attached_upload_id IS NOT NULL AND attached_slug IS NOT NULL
      AND attached_entry_point IS NOT NULL AND snapshot_dir IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS ai_messages (
  id TEXT PRIMARY KEY NOT NULL,
  turn_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL CHECK (length(CAST(content AS BLOB)) <= 16384),
  model TEXT,
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'ok', 'error')),
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (turn_id, role),
  CHECK (role = 'assistant' OR
    (model IS NULL AND input_tokens IS NULL
      AND output_tokens IS NULL AND duration_ms IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_ai_messages_user_session_created
  ON ai_messages(user_id, session_id, created_at, id);
```

Identifiers are server-generated UUIDs except the existing verified user ID. `current_generation` is a generated basename, never an absolute path; `snapshot_dir` is a server-created `.pre-edit-<timestamp>` basename; `entry_file` is validated relative content path. `attached_upload_id` is intentionally not cascading against uploads: deletion/expiration must not delete the user's workspace. Check target availability at edit operations instead.

Required DB interfaces in `db.ts`: lazy `getOrCreateAiWorkspace(userId)`, fetch workspace without creation for reads, compare-and-switch workspace state by `(user_id, revision, current_generation)`, insert/finalize a turn pair in a transaction, fetch current-session transcript in deterministic `(created_at,id)` order, and explicit `deleteAiDataForUser(userId)`. No public raw DB query interface.

Each accepted model call has one user row and one assistant row sharing `turn_id`, `user_id`, `session_id`. Insert both pending rows before the call. On success store the user text and validated assistant summary, not the raw manifest; the assistant row carries model/tokens/duration once per turn. On failure finalize as error with a safe summary/code, preserving obtainable usage. Unknown token usage remains null. Exclude pending/error turns from subsequent model history. After an interrupted process, pending rows are historical interrupted attempts, not replay instructions; do not retry them automatically.

The successful workspace pointer switch and successful message finalization occur in one DB transaction. If that transaction cannot commit, the old workspace remains active and success is not returned. File staging must already be complete before entering that transaction.

### 5. Workspace layout and atomic application

Logical workspace root:

```text
storage/.workspaces/<verified-user-id>/
  .staging/<generation-uuid>/content/...
  .generations/<generation-uuid>/content/...
  .generations/<generation-uuid>/metadata.json
  .pre-edit-<timestamp>/content/...
  .pre-edit-<timestamp>/metadata.json
```

Use `getStorageDir()` so test workspaces resolve under `test/tmp-storage/.workspaces`, never production storage. All names outside `content/` are server-controlled. Metadata records the immutable generation's exact content paths, byte counts, editable/opaque classification and entry file. Clients/models cannot write metadata. The DB's `current_generation` is the active pointer; null means an empty workspace, revision 0. There is only one logical workspace, even though atomic writes use physical generations.

Apply a manifest as one operation:

1. Acquire user guard; read active workspace/revision and materialize a consistent current editable-file snapshot. Validate the whole proposed final file set before touching active state.
2. Create a fresh `.staging/<uuid>` on the same filesystem. Build the complete next content set: copy retained editable files, apply full-content add/update operations, omit deletes, and carry opaque files byte-for-byte. Do not use hardlinks or follow symlinks. Recheck file paths/types/bytes and counts in staging.
3. Write immutable server metadata; close file handles. Rename the complete staging directory into `.generations/<uuid>`. This directory is not live yet.
4. In one SQLite transaction, verify the user still exists and compare-and-switch `(revision,current_generation)` to the new generation, incrementing revision once; finalize the successful turn. The DB pointer is the sole publication switch for private workspace state.
5. On CAS/DB failure remove only the newly prepared generation, keep the old pointer/files, and return the specified failure. On success remove obsolete workspace generations once readers no longer reference them. Reads materialize bounded bytes under the guard or an equivalent generation pin; do not delete a generation during a read. A busy chat may still be inspected through its previously committed generation.

Do **not** implement two successive renames of `user-root` as an allegedly atomic swap: that leaves a missing-root window and complicates snapshots. Never update live files in place. No upload storage reconciliation routine may prune `.workspaces`. On access, private workspace helpers may remove unreferenced staging/generations from interrupted operations while holding the guard; do not remove the active generation or active snapshot and do not add TTL.

Account deletion must cancel/finish an in-flight user operation safely, reject new operations, explicitly delete AI rows with the account's DB transaction, and remove the whole user workspace including snapshot. A late provider response rechecks account existence before any pointer switch and cannot recreate the workspace. A filesystem cleanup failure must be surfaced, not reported as complete deletion; retain enough context to retry that deletion. Do not silently apply upload-expiration cleanup to persistent workspaces.

### 6. LLM prompt and validated manifest protocol

There is **one** protocol for initial and patch turns:

```json
{
  "summary": "Created a responsive landing page and stylesheet.",
  "files": [
    { "op": "add", "path": "index.html", "content": "<!doctype html>..." },
    { "op": "add", "path": "styles/site.css", "content": "body {...}" },
    { "op": "update", "path": "scripts/site.js", "content": "console.log('updated')" },
    { "op": "delete", "path": "old-page.html" }
  ]
}
```

The example illustrates the vocabulary, not a valid initial turn containing updates/deletes. `add` requires an absent editable path; `update` requires an existing editable path and replaces the **entire** file; `delete` requires an existing editable path and has **no content field**. No diffs, JSON patches, append, rename, shell, external fetching, or base64 operations. Initial empty-workspace turns use adds and must create root `index.html`. For attached sites, the seeded entry file is retained at its existing relative path; do not rename it as an incidental edit.

The server-owned system prompt MUST instruct, in substance:

> You generate and edit static website text files only. Return exactly one JSON object with keys summary and files, with no markdown fence or surrounding prose. Each file operation is exactly add, update, or delete. Add/update contain a safe relative POSIX path and the complete UTF-8 text content. Delete contains only op and path. Preserve unchanged files by omitting them. Do not request tools, commands, builds, packages, backend code or secrets. HTML/CSS/JavaScript run only in the visitor's browser. Allowed generated extensions are .html, .css, .js, .md, .txt, .svg, .json. Respect the supplied active entry file, editable-file context and 50-file/5-MiB-total/1-MiB-file limits. Existing opaque asset bytes are unavailable and immutable; do not invent operations on unavailable paths. Use relative references for local generated assets. Return a short factual summary; do not claim publication occurred, because generation does not publish.

Prompt construction is server-controlled: system instruction; the last four successful user/assistant turn pairs from the **current session**, with history capped at 32 KiB UTF-8 total by dropping oldest complete pairs; a separate clearly delimited current workspace object containing **every editable file's path and full current content**, entry file, revision and constraints; then the submitted user message. Do not use the stale draft's heuristic of sending files selected by the model's last summary. Current files, not conversational memory, are source of truth. No opaque contents, site data records, passwords, owner tokens, cookies, key, or workspace absolute paths enter model context. No opaque paths are included in the model file list; validation, not prompt visibility, enforces their immutability. The provider may reject a large context; report that failure without pruning editable files invisibly, increasing caps, or executing extra selection/repair calls.

Treat all current file contents, user instructions, and prior model text as untrusted data; they cannot override the server's protocol. Static code can include browser-side interactions, but no server execution/build step is offered. External asset references are not fetched by Jolt during generation.

Validate **before staging**:

- Completion content parses as one JSON object, with exactly `summary` and `files`; no fenced-JSON extraction, surrounding prose salvage, unknown keys, tools, or coercion.
- `summary` is a string, nonblank, maximum 4,096 UTF-8 bytes. `files` is an array of 1-100 operations. Every operation is an object with exactly the keys required by its vocabulary. Content is a string, valid text without NUL; no binary/base64 protocol. Empty content is legal. Unknown operations/types fail the whole turn.
- Paths are nonempty relative POSIX paths, maximum 240 UTF-8 bytes, maximum 100 bytes/segment. Reject leading `/`, backslashes, drive letters, colon, NUL/control characters, URL escapes (`%`), empty segments, `.`, `..`, trailing slash, and any segment starting with `.`. Segments use `[A-Za-z0-9_-][A-Za-z0-9._-]*`. Do not normalize a rejected path into a different accepted path.
- Reject file/directory-prefix collisions, duplicate operation paths, and case-folded collisions across the final file set (including opaque assets), so macOS development and Linux production behave consistently. An operation cannot refer to an opaque path or create a path colliding with one.
- Generated/updated paths have an allowed editable extension (case-insensitive). Reserved first segments include `_jolt` and any app path rejected by `isBlockedAppPath('/' + path)`; all private dot-prefixed workspace metadata names are already forbidden. `.md` is an ordinary editable asset; do not invent an `index.md` reservation.
- Resolve all candidate filesystem paths inside the chosen content root using component containment, and verify existing roots/parents/files with `lstat`/realpath. Reject symbolic links, nonregular files, unexpected metadata/content paths, and escapes even if lexical checks passed.
- Calculate UTF-8 byte sizes from the final editable set after all operations: ≤50 files, each ≤1,048,576 bytes, total ≤5,242,880 bytes. Boundaries are inclusive. Deletes count toward neither final count nor bytes. The final active entry file must still exist and be editable `.html` or `.md`; new mode requires `index.html`.
- Any invalid/oversized **provider-produced** manifest returns 502 `invalid_model_output`, not 400 blaming the user, and applies zero operations. Client body caps return 413 separately.

No success response or assistant success transcript is emitted until the validated generation is active.

### 7. Exact HTTP contracts

All shapes below use UTF-8 JSON except the existing multipart replacement route. Reject unknown body keys and invalid types; revision is a nonnegative safe integer. A client first loads `GET /api/ai/files` and uses its revision for mutations.

For `/api/ai/**`, errors are consistently:

```json
{ "error": { "code": "workspace_busy", "message": "A workspace operation is already running." } }
```

Set the specified HTTP status; safe messages may explain the actionable limit but never include provider bodies, keys, absolute paths, stack traces, or raw prompts. A 429 additionally includes `retry_after: integer` at top level and the same `Retry-After` header.

Shared statuses: 503 `ai_unavailable` (availability first), 401 `authentication_required`, 403 `origin_mismatch` on mutations, 400 `invalid_request`, 413 `request_too_large`, 409 `workspace_busy` or `workspace_conflict`, 500 `workspace_storage_failed`. GETs do not require an Origin header. AI mutation responses include only committed state.

**Common workspace response (`WorkspaceState`):**

```json
{
  "revision": 3,
  "entry_file": "index.html",
  "files": [
    { "path": "index.html", "bytes": 1280, "editable": true },
    { "path": "images/logo.png", "bytes": 8192, "editable": false }
  ],
  "editable_files": 1,
  "editable_bytes": 1280,
  "opaque_files": 1,
  "opaque_bytes": 8192,
  "target": { "slug": "sample-site", "url": "https://sample-site.sites.example.net/" },
  "restore_available": true
}
```

Files are sorted by path. New mode has `target: null`, `restore_available: false`; empty workspace has no files and the planned default `entry_file: "index.html"`. Target URL is canonical or null if host configuration is currently unavailable; inspection does not publish. No DB entry_point, generation/snapshot directory, ownership secrets, or absolute path is exposed.

#### POST `/api/ai/chat`

- Auth: existing registered-user account, regardless of publishing mode; if attached, recheck target ownership/admin eligibility and live immutable upload ID before the call.
- Body: `{ "message": string, "revision": integer }` only, bounded JSON as above.
- Success 200:

```json
{
  "turn_id": "server-uuid",
  "summary": "Updated the heading and button colors.",
  "files": ["index.html", "styles/site.css"],
  "workspace_files": 2,
  "revision": 4,
  "usage": { "model": "configured-model", "input_tokens": 2400, "output_tokens": 1100, "duration_ms": 1800 }
}
```

`files` lists all current editable paths, not just changes; `workspace_files` is that editable count. Usage token fields may be null. Existing opaque counts/classification are obtained from the files-list endpoint, never added to model output.
- Additional errors: 429 rate budget; 502 `provider_failed` for non-2xx/transport/envelope errors or `invalid_model_output`; 504 `provider_timeout`; 404 `target_unavailable` for deleted/expired attached target; 403 `target_forbidden` if ownership/admin eligibility changed. Output overflow is 502 `provider_response_too_large`. No automatic retries. Workspace/revision remain unchanged on any failed generation.

#### GET `/api/ai/files`

- Auth: registered-user account. No body or query controls.
- Success 200: `WorkspaceState` plus `messages`, the newest 20 current-session rows ordered for display, each `{ "id", "turn_id", "role", "content", "status", "created_at" }`. Return pending/error rows for honest UI state; never send raw manifests or credentials.
- If no workspace exists, return the empty state (`revision: 0`, `messages: []`) without creating filesystem content or chat records. Reads after relogin recover committed files/session.

#### GET `/api/ai/files/[...path]`

- Auth: registered-user account; canonical validated relative path, decoded once. No workspace/owner selection.
- Success 200: `{ "path": string, "content": string, "bytes": integer, "revision": integer }`; content is JSON-escaped text and response is `application/json; charset=utf-8`, not executable HTML/SVG/JS.
- 400 `invalid_path`; 404 `file_not_found`; 403 `opaque_file` when the path exists but is not editable. Do not provide opaque download/bytes through this route.

#### POST `/api/ai/preview`

- Auth: registered-user account plus existing upload policy in the shared creation helper. This is **new-mode only**; attached workspaces return 409 `attached_workspace` with guidance to replace the existing upload.
- Body (optional fields have the given defaults):

```json
{
  "revision": 4,
  "title": "My site",
  "expiration": "1h",
  "password": "",
  "enable_data": false,
  "cf-turnstile-response": "current-widget-token"
}
```

`title` defaults to empty string (trim/slice 100 characters as creation); `expiration` defaults to `1h` (empty means none, otherwise existing expiration parser); `password` defaults to empty string (trim, maximum 200 characters under creation rules); `enable_data` defaults false and must be boolean; CAPTCHA defaults absent. No filename, generated file payload, user ID, owner token, or target slug is accepted.
- Package the committed complete editable set into a ZIP named `ai-site.zip`, excluding all metadata/snapshot/staging directories. Call the same extracted creation helper as `/api/upload`; do not call the public route over HTTP or duplicate its pipeline. The helper applies auth, **one** existing upload-rate check, current Turnstile policy, account upload limits/never_expire, password hashing, data opt-in validation, expiration, slug/UUID/token creation, canonical URL failure before persistence, writeUploadContent, insertion and response.
- Success 200 is exactly the current creation result:

```json
{
  "slug": "new-slug",
  "url": "https://new-slug.sites.example.net/",
  "entry_point": "new-slug/index.html",
  "owner_token": "one-time-owner-token",
  "expires_at": "ISO-string-or-empty-string",
  "title": "My site",
  "data_enabled": "true",
  "url_with_unlock": "https://new-slug.sites.example.net/?unlock=..."
}
```

`data_enabled` is present only when enabled; `url_with_unlock` only with password. Do not add owner-token URLs or substitute a new result contract. Each successful call creates a new owned upload/slug; workspace stays intact and is not automatically attached to that upload.
- Additional errors: 409 `empty_workspace`; creation-compatible 400 expiration/password/CAPTCHA/data-password errors, 403 data-toggle-disabled, 413 packaged ZIP/account limit, 429 upload limit, 503 unavailable canonical origin/data feature. Valid text at its 5-MiB workspace ceiling can still produce a ZIP above the web/account compressed-size limit; report 413, never silently increase the established upload limit.

#### Phase 6 control endpoints (required, not deferred)

**POST `/api/ai/attach`** body `{ "slug": string, "revision": integer }`; registered user and origin guard. Success 200: complete seeded `WorkspaceState`, revision incremented once, target populated, restore available. Attachment replaces the prior workspace/session only after the entire source validates; the UI must warn about replacing current draft files before sending it. Errors: 400 unsafe/unreadable source layout, 403 non-owner/anonymous owner-token site, 404 missing/expired site, 409 busy/revision/source-generation conflict, 413 `editable_workspace_too_large` with the exceeded count/per-file/total limit, 413 `source_too_large` for the existing archive extraction ceiling. No provider call or upload row is created.

**POST `/api/ai/restore`** body `{ "revision": integer }`; registered user and origin guard, recheck attached target eligibility. Success 200: `WorkspaceState` after restoring the active edit session's immutable pre-edit snapshot into a **new** workspace generation/revision. Errors: 409 `no_edit_snapshot`, busy/revision conflict; 403 target forbidden; 404 target unavailable. This is a local workspace restore, not an automatic hosted rollback. The user then explicitly publishes through replacement; original site settings/expiration are never restored from a snapshot.

**POST `/api/ai/reset`** body `{ "revision": integer }`; registered user and origin guard. Success 200: empty new-mode `WorkspaceState`, new `session_id`, revision incremented once; closes the old edit session and clears its active snapshot/attachment. No provider or upload call. Works even if the attached site was deleted/expired so users are not trapped. Existing message rows remain as cost history but are excluded from the new session/UI/prompt. UI confirmation is required before discarding active draft files.

#### PUT `/api/uploads/[slug]/content`: AI-workspace mode

Keep the existing public multipart `file`/`owner_token` mode unchanged. Add an explicit, mutually exclusive builder mode to this **same endpoint**, not another publish route:

```text
multipart/form-data
  ai_workspace_revision = decimal nonnegative integer
  cf-turnstile-response = current token, when required
```

In builder mode `file`, `owner_token`, title, password, expiration, enable_data, and other management settings are invalid; an API token alone is insufficient. Feature gate, registered-user verification and app-origin guard apply. Auth additionally requires attached `user_id` match or an admin session, nonanonymous target, matching immutable target ID/slug, and live/unexpired target. Package editable **and opaque** files server-side; never round-trip opaque bytes through the browser. Call the shared replacement preparation/publication helper used by ordinary file replacement. Apply existing rate/size/CAPTCHA policy exactly once.

Success 200 remains `{ "slug": string, "url": string, "entry_point": string }`, no owner token or creation metadata. Update the workspace's attached baseline to the newly committed target entry_point after success, without replacing its original session snapshot. Publication does not alter editable content/revision. The original immutable upload ID, slug, created_at, title, password hash, owner token, expiration, data_enabled and per-site record DB remain unchanged.

Before publication, compare against the **entry_point observed on attach / last successful builder replacement**, not a freshly read pointer that would overwrite someone else's intervening edit. Return 409 on mismatch and leave both workspace and live site unchanged; UI offers explicit reattach, not an automatic overwrite/retry. Preserve the existing conditional DB entry_point switch and recheck ownership/target ID/expiry at that switch. If the site disappeared/expired return 404. A lost response or failure to record the refreshed workspace baseline must fail safe on the next request (409/reattach), never infer permission to overwrite newer content.

Builder-mode failures use the AI error shape where handled by the AI branch; ordinary multipart clients retain their current error behavior. Status set includes 400 invalid multipart/CAPTCHA, 401 unauthenticated, 403 ownership/origin, 404 target unavailable, 409 no matching attachment/stale revision/stale site/busy, 413 archive limit, 429 upload limit, 503 unavailable AI/hosting, and 500 storage failure.

### 8. Publishing helper boundary and entry-point preservation

Create `server/utils/upload-publish.ts` rather than a second AI-specific upload policy. Its internal typed interfaces are:

- `createUploadFromContent(event, { data: Buffer, filename: string, title?: string, password?: string, expiration?: string, enableData?: boolean, turnstileToken?: string }): Promise<UploadResult>`: preserves all creation rules and result fields. `/api/upload` remains the multipart adapter; `/api/ai/preview` is the JSON/workspace adapter. User attribution is resolved from the request, not a caller-supplied user ID.
- `replaceUploadFromContent(event, { slug: string, data: Buffer, filename: string, ownerToken?: string, turnstileToken?: string, expectedEntryPoint?: string, expectedUploadId?: string, preferredEntryFile?: string }): Promise<{ slug: string; url: string; entry_point: string }>`: shares existing replacement rules, CAS and generation retirement. Only trusted builder code supplies expectation/entry overrides, after its narrower eligibility check. Public multipart fields cannot select these overrides.

Retain `writeUploadContent`/ZIP validation as the shared byte preparation. Extend its internal ZIP extraction options with a validated `preferredEntryFile` only where needed for **attached** content. Default public ZIP behavior remains HTML selection as today. The trusted attached option must be an existing regular `.html` or `.md` file inside the extracted root, and selection occurs only after the same complete ZIP containment/size checks. This is required to preserve an attached Markdown-only upload and an existing non-default/nested entry; do not synthesize an index.html or convert Markdown as an incidental product change.

For attachment, seed the exact currently served root (`dirname(entry_point)`), mapping its files relative to that root and using `basename(entry_point)` as the active entry file. For a nested-entry site, outer unservable original ZIP files are not part of the live served tree. Published replacement preserves that site's root/asset behavior through the preferred entry, including the case where multiple HTML files would otherwise select a different default. No metadata or snapshot is zipped.

### 9. Existing upload attachment, opaque assets and snapshot

1. Under the user's operation guard, load the target row. Require an existing account-owned (`user_id != null`) unexpired site and matching user ID, or a registered-user requester with an authenticated admin session. A matching owner token never qualifies. Record immutable upload ID and entry_point.
2. Resolve the current served root within storage using realpath containment; never read through symlinks, staging/trash paths, user-supplied roots, site-data databases, or another user's workspace. Walk only regular files/directories from that root. Unsafe names/nonregular files are a clear attachment error, not silently dropped files.
3. Classify allowed-extension files that decode as valid UTF-8 without NUL as editable. All others, including binary bytes with an editable-looking extension, are opaque. Editable count/bytes/per-file must satisfy the same caps; refuse attachment atomically with 413 and a clear limit. Bound all source file bytes by the existing 100-MiB archive extraction ceiling. Opaque files are listed read-only in the UI but their bytes never enter model context or the text-read endpoint. The browser cannot create/upload new opaque files in this MVP.
4. Copy the complete source into a new private generation **and** `.pre-edit-<timestamp>/` snapshot with immutable metadata; recheck source entry_point/ID/ownership/expiry before switching workspace state. If it changed during copying, return 409 and retain the old workspace. Do not seed a mixture of two published generations.
5. Atomically record target/baseline/session/snapshot with the new workspace pointer/revision. A new attach closes the prior edit session; keep one active snapshot per workspace, deleting the old session's local snapshot only after the new attachment is committed. This is operation cleanup, not a time-based retention policy. Snapshot persists across logout/restart for the active session and is never published.
6. Chat modifies only editable files. Every new staged generation carries opaque assets byte-for-byte with unchanged paths. Reject manifest add/update/delete against opaque paths or path collisions. Publishing includes those assets; compare hashes in tests to prove preservation.
7. “Restore previous version” always means the site bytes at **this session's attach**, not the preceding chat turn or preceding publication. Restore stages a new local generation from the snapshot. A subsequent explicit replacement can restore those bytes at the same URL only if its current attachment baseline still matches; deletion, expiration, concurrent external replacement and changed ownership remain authoritative.

### 10. UI behavior

- Insert a small accessible Upload | Build tab strip in the existing hero `.box`, **above** each tab's own sign-in/form content. Upload remains selected by default and its behavior/Turnstile/result storage stays intact.
- Hide Build and all dashboard builder links/actions when `aiBuilderAvailable !== true`, including SSR and later client navigation. Ignore Build query parameters when unavailable. The minimal-landing variant (`!showUploader`) stays unchanged and has no tab.
- Use `/?tab=build` as the secondary dashboard deep link; use `/?tab=build&edit=<slug>` for eligible row actions. Query parameters only preselect/identify; they never grant authorization or silently replace workspace contents. With `edit`, show a confirmation/Attach action before sending `/api/ai/attach`. No new page route.
- Builder always requires account sign-in, even in open publishing mode. Restricted logged-out Build uses the existing notice and allowed register link; open-mode logged-out Build similarly explains “Sign in to use AI Builder.” Do not make anonymous upload policy stricter on the Upload tab. An admin-only dashboard session shows a sign-in requirement for AI actions until a registered account is also present.
- `components/AiBuilder.vue` fetches current workspace/messages on opening; provides message input, safe chat/summary display, busy/error states, file list, read-only text viewer, editable/opaque labels, revision management, and one visible action appropriate to mode. Disable local controls while a mutation runs, but rely on server guards as authority. Show 429 wait time and stale/busy guidance; do not auto-resubmit paid chat calls.
- New mode shows Preview (publishes a new real site) plus title/expiration/password/data opt-in and Turnstile using existing conventions. Save the result in the same sessionStorage keys as the upload form and navigate to `/result/<slug>`. Explain that each Preview is another owned live upload and offer the existing dashboard link. Do not auto-attach the preview.
- Attached mode clearly shows target URL and “Publish changes” (same URL), Restore previous version, and Start a new site. Hide creation settings: editing cannot change title/password/expiration/data state. Publish uses the multipart AI-workspace mode of the existing PUT endpoint; show the unchanged canonical URL and dashboard link after success. It must not enter new-create owner-token/result-storage paths or add duplicate My Sites entries.
- Add eligible per-row “Edit with AI” action and a secondary general “AI builder” link in dashboard. Add a narrow `ai_editable` boolean to existing list items (true only for nonanonymous, unexpired rows authorized by that list's user/admin scope); that flag is UI guidance, not server authorization. Do not expose additional account/secrets fields just to implement eligibility.
- Reset/attach warns that current draft contents/session will be replaced. Restore warns that current editable changes are discarded locally and publication is still explicit. Never promise the external model's result is safe/trustworthy or private after publication.

## Scope

### Future implementation files

Prefer these files/helpers and established conventions:

- Create `server/utils/ai-builder.ts` (availability/provider/prompt/manifest contract), `server/utils/ai-workspace.ts` (private generations/snapshot/ZIP preparation), `server/utils/ai-rate-limit.ts` (user budget and shared operation guard), and `server/utils/upload-publish.ts` (shared creation/replacement pipeline).
- Update `server/utils/db.ts`, `server/utils/upload-content.ts`, `server/api/upload.post.ts`, `server/api/uploads/[slug]/content.put.ts`, `server/api/config.get.ts`, `server/api/admin/users/[id]/delete.post.ts`, and management list routes `server/api/{user,admin}/uploads.get.ts`.
- Create `server/api/ai/{chat.post,files.get,preview.post,attach.post,restore.post,reset.post}.ts` and `server/api/ai/files/[...path].get.ts`.
- Create `components/AiBuilder.vue`; update `pages/index.vue` and `pages/dashboard/index.vue`. A small shared result interface/helper within existing component/composable conventions is acceptable only if it removes duplicate result-handling logic and all affected callers migrate; do not introduce a parallel result-storage convention.
- Add behavior tests alongside AI utilities; extend `test/integration/upload.test.ts` and `test/setup-integration.mjs`. Use existing fixtures or build local ZIP fixtures in that test; modify `scripts/build-test-fixtures.mjs`/`test/fixtures` only if a checked-in reusable binary fixture is genuinely needed.
- Update `package.json`/`package-lock.json` to move existing `archiver` to runtime dependencies. No agent SDK dependency.
- Update `.env.example`, `README.md`, `docs/how-to.md`, `docs/how-to-use-upload-endpoint.md`, and `docs/privacy-policy.md` for actual behavior. Update this plan's implementation status only after verification.

### Explicitly unchanged unless drift proves necessary

`docker-compose.yml` (existing storage/data volumes suffice), `Dockerfile` (no execution containers), `nuxt.config.ts`/`server/tasks/cleanup-expired.ts` (no workspace TTL), hosted-origin dispatcher and site-data APIs (reuse isolation; no AI access to records), completed historical plans, login/registration product policy, unrelated editor/paste/markdown creation routes, billing/admin usage UI.

### Out of scope

BYOK; SSE/token streaming; agent/tool runtime; shell, containers, npm installs or static-site builds; server execution of generated code; arbitrary backend hosting; binary/AI image generation; uploading new assets into workspace; multiple workspaces per user; workspace TTL; distributed deployments/locking; model fallback or automatic retries; public/anonymous builder; owner-token attachment; automatic merge/rebase of concurrent live edits; history browsing/version management beyond one active pre-edit snapshot; private/unpublished browser preview; automatic preview-to-draft attachment; usage dashboards/pricing/billing beyond persisted `ai_messages` rows.

## Execution steps and verification gates

Implement in this order. Every gate is mandatory; scoped utility checks may run while developing. Run the project-wide validation and the integration build once after all phases are integrated, not against half-landed sibling changes. The final integrated test run must exercise every phase gate below, not just compilation.

### Phase 1 — Feature boundary and provider connection

1. Add runtime availability and env docs; expose only `aiBuilderAvailable` in config.
2. Add bounded server-only completion adapter, fixed request shape/timeout/one-call semantics, safe errors and usage parsing; implement separate user rate budget/operation guard.
3. Add shared AI request auth/error/origin behavior without changing upload auth.

**Gate:** scoped `npx vitest run server/utils/ai-builder.test.ts server/utils/ai-rate-limit.test.ts` exits 0, covering disabled/missing/invalid configuration, response overflow without Content-Length, timeout/cancellation, malformed/truncated/tool completion, exact rate boundary/window expiry, guard release on error and independence between users. Use real local HTTP responses for provider behavior, not mocked-fetch echoes. Integrated cases A1/A2/A8/A9 below prove unavailable endpoints, account auth and actual mock request counts. Never use a real paid key in tests.

### Phase 2 — Schema and transactional private workspace

1. Add exact tables and DB interfaces; make all stored content byte-bounded.
2. Implement lazy workspace/generation metadata, path validation, final-set accounting, staged rename + DB CAS, consistent file reads and user deletion coordination.
3. Implement list/read endpoints and reset; workspace storage never becomes a served entry_point.

**Gate:** scoped `npx vitest run server/utils/ai-workspace.test.ts` exits 0. Cases prove inclusive quota boundaries; lexical/realpath/symlink/case/prefix collision rejection; failed multi-operation write/CAS leaves old bytes/revision; deletion during preparation cannot resurrect an account; readers observe a committed complete generation; JSON text reads never become executable HTML. Integrated A3/A5/A10/A11 inspect filesystem and DB state. Do not test source text or default-object copies.

### Phase 3 — Chat turns and model manifest pipeline

1. Build the current-session prompt with all actual editable content and bounded complete history pairs.
2. Implement chat body/revision validation → guard → rate budget → pending turn pair → exactly one provider call → entire manifest validation → complete generation staging → transactional state/usage finalize.
3. On failure keep active files/revision and record obtainable assistant cost/error; no repair/retry call.

**Gate:** scoped AI utility tests plus integrated A3-A9 demonstrate initial create, follow-up add/update/delete, response/protocol/quota failures leaving identical bytes/revision, usage rows with noninvented tokens, and a held provider response causing immediate same-user 409 while another user can proceed. A provider success followed by storage failure must not emit a successful chat or partially applied files.

### Phase 4 — Shared publication and new-site preview

1. Extract the creation and replacement helpers; migrate `/api/upload` and ordinary content PUT to them while retaining multipart clients, status/policy/ownership and result contracts.
2. Move `archiver` to dependencies; build bounded ZIPs from committed workspace files with no private artifacts.
3. Add preview JSON adapter through the creation helper, including data opt-in and real CAPTCHA policy. No loopback HTTP call, internal exempt flag or duplicated persistence code.

**Gate:** integrated A12-A15 plus all existing upload/replacement scenarios pass. Chat → preview must serve the exact generated HTML/assets at canonical hosted Host; patched chat → second preview produces a different owned slug and patched bytes while first preview stays unchanged. Bad CAPTCHA/disabled data opt-in/missing password/size/rate/origin failure leaves no new upload row/live files. Ordinary upload contract tests continue to pass. Do not merely assert that a helper was called.

### Phase 5 — Landing Build tab, dashboard link and operator/user docs

1. Build `AiBuilder.vue`, safe chat/file surface, revision/busy/error handling and preview options/result navigation.
2. Add Upload | Build in the hero box, query preselection and secondary dashboard link; preserve minimal landing/Upload behavior and signed-in vs admin-only distinction.
3. Document configuration, external-provider disclosure, caps, costs, persistence, account deletion, codegen-only limits, public preview semantics and no current usage dashboard.

**Gate:** actual browser smoke B1-B4 below. Builder unavailable means no Build or dashboard AI action after SSR/navigation; restricted anonymous users see sign-in notice; minimal landing remains unchanged; open-mode anonymous users can still Upload but cannot use Build. Model HTML-looking text is displayed as text, not executed. Browser submits real chat, opens text files and publishes through the result page/canonical hosted URL. A file/component snapshot or passing build alone is not this gate.

### Phase 6 — Attach existing upload, preserve opaque files, restore and replace

1. Implement attach classification/caps/source-pointer recheck and one active `.pre-edit-<timestamp>` snapshot; no model call on attach.
2. Implement local snapshot restore and complete opaque carry-through in every patch generation. Expose eligible dashboard actions/target UI and reset back to new mode.
3. Add the server-packaged AI-workspace multipart mode to existing content PUT; preserve attached entry selection (including Markdown and nondefault/nested HTML) via trusted shared extraction options. Enforce attach-time/last-success baseline plus current ownership/immutable ID/expiry at replacement.
4. Complete docs for local restore followed by explicit stable-URL publication; close and clean old session scaffolding only after new state commits.

**Gate:** integrated A16-A23 and real browser B5. Patch and publish an owned data-enabled/password-protected site containing a binary asset: same slug/immutable ID/URL/settings/record DB; changed text live; omitted deleted editable asset 404; binary hash and served bytes unchanged; snapshot never served. Restore then explicitly publish recovers attached original bytes at the same URL without restoring expiration/settings. Foreign/anonymous/deleted/expired/stale sites, opaque modifications, oversize source and attach/publish races fail atomically with specified statuses. Admin authorization requires the registered-user workspace session. Include Markdown-only and nested/multiple-HTML entry cases, not only index.html fixtures.

### Integrated release gate

After all six phases are complete:

```sh
npm run test:unit
npm run test:composables
npm run test:integration
npm run build
```

All exit 0. The integration command uses the real built Nitro server and locally mocked external provider; it is not a substitute for browser smoke. Start the built server with real runtime app/site origins and the **local** mock provider; exercise B1-B5 below. Remove throwaway smoke scripts/generated artifacts and leave no paid-test credentials. Then `git diff --check` exits 0; `git status --short` contains only implementation Scope changes. Do not commit/push.

For this **plan-only** refinement, do not run implementation/build commands: `git diff --check -- docs/plans/vibe-code-site-builder.md` must pass and `git status --short` must show only this plan document changed (or explicitly report pre-existing user changes rather than deleting them).

## Test plan / measurable done criteria

### Harness contract

Extend `test/setup-integration.mjs`:

- Start a loopback `node:http` OpenAI-compatible mock before starting Nitro. Bind an available loopback port; expose `/v1/chat/completions`; inject its base URL, a clearly test-only key and model into the runtime server environment, not public config or build-time env. Keep the deliberate stale build-time app/site origins.
- Write mock control/base information to the existing ignored `test/.integration-env.json` alongside `JOLT_TEST_URL`. The mock's test-only loopback control interface queues deterministic responses keyed by unique test message/turn marker and can report request counts/captured sanitized request JSON. It is **not** an application route or production reset endpoint.
- Support success/usage, malformed JSON/envelope, non-2xx, chunked overflow, finish_reason length, tool call, held response and timeout. Hold/release via deterministic control events, not sleeps. Do not expose or reuse a real operator key.
- For HTTP availability and open-mode cases, start additional built Nitro instances with the same test-mode paths and distinct app/site ports: missing key, disabled switch, and open publishing mode. They remain sequential test consumers under the **same test file**; unavailable variants do not mutate shared fixtures. Record their URLs in the integration env file. Do not change production config via test-only APIs or alter env in the Vitest process expecting the already-running server to change.
- Stop all Nitro instances and the mock; close held connections and remove integration metadata in global teardown. Keep the existing single-file DB/storage cleanup. Use fresh account/turn IDs and controlled client-IP headers for upload-limiter cases so AI tests do not exhaust unrelated existing upload tests. Long timeout cases may set their own test timeout above 60 seconds; do not weaken the production timeout to make them pass.
- Reuse real admin-create-user and user-login setup and raw Host requests from the existing integration file; send the app Origin for AI mutations. Assertions inspect HTTP results, actual hosted bytes, private filesystem and SQLite records. No live internet or billable provider calls.

### Integration inventory (in `test/integration/upload.test.ts`)

| ID | Scenario and measurable evidence |
| --- | --- |
| A1 | Missing key and kill-switch variants: config false, every AI route and AI-workspace content mode 503, no provider calls or private workspace creation; ordinary upload path unaffected. Invalid base/model availability is covered by utility tests. |
| A2 | Account auth in restricted and open variants: anonymous/web/API/view/owner-token/admin-only cannot use builder (401); real registered user can. Deleted-user signed cookie is rejected. Cross-origin mutation 403; hosted-origin AI API 404. |
| A3 | First chat adds index.html/CSS/JS; GET list/read shows exact contents/bytes/revision; relogin preserves them. Follow-up add/update/delete yields the exact final file set. Prompt received by mock contains current contents, not stale summary-selected files. |
| A4 | Unknown op/keys, invalid type, fenced/non-JSON, bad envelope, missing index, duplicate path, absent update/delete, add-existing, invalid UTF-8/NUL protocol, unsafe/reserved/case/prefix paths: 502 and byte-identical active generation/revision. Parameterize representative payloads; test the validator's complete boundary families in unit tests. |
| A5 | 50 files/5 MiB/1 MiB inclusive boundaries and one-over violations, including replacement/deletion accounting; invalid model proposal leaves all prior files/revision intact. Unsafe direct file read 400/404; user B cannot inspect user A. Private path attempts from app/hosted asset routes never expose generations/snapshot/metadata. |
| A6 | Declared and chunked chat body >8 KiB return 413 before provider call; bad JSON/unknown client fields return 400. Stored UTF-8 message bounds are enforced by DB/helper tests and SQLite byte-length checks, not JS character length. |
| A7 | Valid response stores one user/assistant pair; only assistant has requested/returned model and exact usage/duration. Missing provider usage is null. Invalid manifest/non-2xx/timeout finalizes safe error usage where available, with no raw response/key in API or transcript. |
| A8 | Held response: second same-user chat/attach/reset/restore/publish 409, different user can generate, guard releases after success and failure. Stale client revision fails before provider call. No second repair/retry completion request is observed. |
| A9 | 30 accepted attempts succeed/reach mock; 31st 429 with Retry-After and no call; failed calls still consume attempts. Window expiry/pruning/map ceiling tested with an injected clock in utility tests, not a real hour wait. Chunked provider overflow, timeout, truncation and tools fail atomically. |
| A10 | Injected staging/write/CAS failure in focused workspace tests leaves old readable bytes/revision and removes only fresh failed state. Restart/reaccess ignores orphan staging/generations and never activates an uncommitted generation. |
| A11 | Admin deletes account during held response: no success publication/workspace recreation; AI rows and private directory removed. Expiring/deleting an upload does not TTL-delete an unrelated user's workspace. |
| A12 | Chat → preview → hosted root/asset exact content; new upload user_id is requester. Patch → second preview produces different slug with new contents while first remains old. Dashboard list includes both owned uploads. |
| A13 | Preview extraction excludes internal metadata, generation dirs, snapshots and chat text. Password response has canonical unlock URL and only separate owner_token; protected hosted view/unlock behavior remains existing behavior. Data opt-in validations run before persistence. |
| A14 | Invalid CAPTCHA when enabled, expiration/password/input, compressed ZIP/account size, upload rate and unconfigured hosting/data checks return existing policy statuses and do not create usable upload rows/files. Scoped tests can inject deterministic CAPTCHA verifier behavior; do not require Cloudflare internet in suite. Production browser smoke must use the actual policy configured for that local run. |
| A15 | Existing `/api/upload` and normal multipart replacement contract scenarios remain passing after shared-helper extraction, including data opt-in, API-token/account attribution, nested ZIP entry and conflict/deletion behavior. Update only genuinely changed AI additions, not unrelated response contracts. |
| A16 | Attach owned site without call/new upload: exact live served-root text plus binary classification, revision/session/snapshot committed. Foreign user 403; anonymous target 403 even with matching owner token; admin-only 401; registered user+admin may attach nonanonymous foreign target. |
| A17 | Editable file/count/total overflow 413 with clear exceeded limit and unchanged former workspace/session/snapshot. Binary-looking allowed-extension file is opaque. Unsafe/symlink/nonregular source fails without partial seeding. |
| A18 | Opaque paths/bytes absent from captured model file context; opaque text-read 403; add/update/delete or prefix/case collision against opaque file returns 502; successful patch preserves byte-for-byte hash in all generations/publication. |
| A19 | Existing-site PUT builder mode uses expected attachment and packages on server. Same immutable upload ID/slug/URL/created_at/title/password/owner token/expires_at/data_enabled and preexisting site-data record remain; changed HTML/assets live and deleted editable asset 404. No new row or owner-token emission. |
| A20 | Restore resets local content to attach snapshot, increments revision, leaves hosted site unchanged until explicit PUT. PUT restores original bytes/binary hash at stable URL while retaining current settings/expiration. Snapshot HTTP paths remain unavailable. Reset returns empty new mode, closes active snapshot, and prompt/UI excludes old session while cost rows remain. |
| A21 | Deleted/expired/reowned target rejects chat/restore/replacement appropriately; reset remains available. External content replacement since attach returns 409 and cannot be overwritten automatically. Changing target during source copy causes attach conflict. |
| A22 | Existing nested entry (served-root subset), multiple HTML files with nondefault active entry, and standalone Markdown attach/patch/publish preserve original root/entry/asset behavior. Default public ZIP still requires HTML; trusted attached Markdown entry is not a public bypass. |
| A23 | Live replacement race/CAS/ownership/expiry failure retains previous site and private draft and removes only new failed publication files; reattach/session change cleans only obsolete private snapshot/generations. No expired site revival or settings/records mutation. |

### Browser smoke (actual surface, mandatory)

- **B1:** With unavailable/missing-key and disabled-switch runtime configs, load landing/dashboard and navigate client-side: no Build/tab/action; calling AI endpoints still returns 503. With available key, check restricted logged-out sign-in notice and minimal landing; check open mode keeps anonymous Upload but gates Build.
- **B2:** Sign in, open `/?tab=build`, generate a small site against the local provider mock, inspect files/text. Supply HTML-looking summary content and verify it stays plain text. A stale/busy error must not silently resubmit a paid turn.
- **B3:** Preview with real local Turnstile configuration policy, view result/canonical hosted site, refresh and inspect CSS/JS. Return, patch, preview again; first and second hosted URLs show their respective versions and both appear in dashboard. No app-origin generated content renders.
- **B4:** Reload/logout/login recovers workspace/transcript; switch Upload/Build without breaking ordinary upload, widgets or query-state handling. Test narrow viewport and keyboard tabs/controls; no new design system is required.
- **B5:** Dashboard Edit with AI → explicit attach confirmation → owned existing protected/data-enabled site with binary asset → patch → Publish changes. Verify stable hosted URL/settings/data record and binary asset. Restore previous version locally, verify hosted version is unchanged until explicit Publish changes, then verify original bytes at the same URL. Try a concurrent external edit and observe conflict/explicit reattach, not automatic overwrite.

### Done means all of the following

All six phase gates and A1-A23/B1-B5 are satisfied; commands in the integrated release gate exit 0; new/updated tests cover behavior rather than source/wiring; ordinary publishing remains compatible; no generated code executes server-side; no API key/prompt/provider raw output leaks; private workspace/snapshot files are never served or included in new-preview ZIPs; every model call has bounded input/output handling and cost rows; a user can create/iterate/publish **and** attach/iterate/restore/replace an existing eligible site end-to-end. Passing tests alone without hosted HTTP proof and browser smoke is not completion.

## STOP conditions

Stop and report the exact conflict/missing prerequisite; do not ship a narrowed substitute:

- HEAD or intervening changes invalidate account ownership, hosted origin isolation, served-root semantics, upload policies, or the existing CAS/lifecycle contract. Re-read affected sections and reconcile; do not implement from stale line numbers.
- The operator cannot provide a real compatible gateway/model/key for deployment, or that gateway requires an agent runtime, unsupported tools, different multi-call protocol, or unsupported fixed request contract. Local mock verification is still reachable; do not claim a real provider was verified or guess fallback credentials/endpoints.
- Hosting cannot return a canonical isolated-origin URL, or generated content could reach app APIs/execute on the app origin. Keep publication fail-closed; do not add app-origin iframe/srcdoc previews or permissive CORS.
- Atomic workspace pointer switching cannot be made safe on the deployed storage/SQLite arrangement, or multiple Nitro processes/replicas must share the workspace. A process-local guard is not a distributed lock; distributed deployment is outside this MVP.
- Attaching the exact served root cannot preserve an eligible site's current entry/asset behavior, opaque bytes, or supported Markdown/nested entry without violating publishing validation. Do not quietly drop binaries, convert the site, substitute a new slug, or omit phase 6.
- An ownership/deletion/expiration/content-pointer race can overwrite another writer's site, resurrect a deleted user/site, publish partial state, or mutate password/data settings/records. Include the missing guard before release; if incompatible with current infrastructure, report it.
- Account deletion cannot remove private workspace/transcript state or prevent late provider-response resurrection. Do not call TTL deferral permission to retain deleted-account AI data silently.
- A required test/browser scenario cannot be exercised with available runtime tools, or any specified done criterion fails. Report exercised evidence and missing capability; do not present scaffold/tests-only proof as a finished feature.
- Implementation needs new product scope (BYOK, agents, asset upload, multiple workspaces, automatic merge/retry, private preview, usage UI). Do not add it “while here”; retain this contract and report the scope conflict.

## Maintenance/review notes

- Provider credentials must remain server-only at runtime; never bake them into Nuxt public runtime config, generated bundles, prompts, transcripts, or logs. Logs/errors should use safe identifiers/status, not raw request/response bodies.
- Paid attempts, not only successful file writes, consume the chat budget. Upload rate/CAPTCHA and AI rate/guard are different controls; extraction must not double-count or exempt builder publication. In-memory guards reset on restart and do not protect multiple replicas.
- Model manifests are untrusted. Browser-side scripts/HTML/SVG are deliberately allowed on the isolated hosted origin; JSON validation/path containment does not make generated sites trustworthy. Render management-side model/file text only as text.
- Workspace CAS and hosted entry_point CAS are separate switches. Never use a newly read hosted pointer to erase attach-baseline conflicts, and never let direct client fields select another workspace/generation/source path.
- Opaque files survive unchanged; they are not model context, editable downloads, generated content, or a new asset-upload facility. Review prefix/case collisions, invalid UTF-8 classification and ZIP inclusion whenever path handling changes.
- One active pre-edit snapshot is a local byte restore, not a full settings/data backup or multi-version history. Restore never revives expiration or rolls back passwords/site-data records. Workspaces persist across login/server restart; TTL remains intentionally deferred.
- Backups must include both the SQLite AI metadata/messages and private storage generations/snapshot consistently; generated files and transcripts can contain sensitive user material. Privacy docs must disclose transmission of user prompts/current editable contents to the operator-configured provider, opaque nontransmission, account-linked usage/storage, persistence and account deletion. Do not claim an admin usage dashboard exists; usage is raw DB rows in this release.
- Changes to upload creation/data opt-in/CAPTCHA/size policy belong in the shared publishing helper so ordinary uploads and AI previews cannot drift. New-format or entry-selection changes must preserve ordinary public ZIP validation and attached-site behavior.
- The historical static-content-update plan's no-version-history scope remains correct for ordinary uploads; this plan adds a private AI edit-session snapshot only. Do not rewrite historical plans as if their completed behavior were the new AI specification.
