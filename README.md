# JoltHost — Static Site Pastebin

<img width="1374" height="1112" alt="image" src="https://github.com/user-attachments/assets/338d5167-c9fd-4468-b2c8-8190d141a86f" />

A minimal pastebin for static sites: upload an HTML file, paste raw HTML or Markdown, or upload a ZIP and get a shareable URL. Built with **Nuxt 3**, **SQLite** (better-sqlite3), and **Node fs**.

## Requirements

- **Node.js** ≥ 18 (recommended ≥ 20 for Nuxt 3)

## Setup

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

For the **admin dashboard** at `/admin`, set an admin password (see [Environment](#environment)).

## Features

- **Three ways to publish**
  - **Upload** — `.html`, `.md`, or `.zip` via drag-and-drop or file picker at `/`, or via `POST /api/upload`
  - **Paste HTML** — raw HTML at `/paste` or via `POST /api/paste` (writes a single `index.html`)
  - **Paste Markdown** — raw Markdown at `/markdown` or via `POST /api/markdown` (writes a single `index.md`)
- **Markdown rendering** — `.md` pastes are rendered server-side to a full HTML page with a floating **theme switcher** (GitHub, Dracula, Solarized, Nord); theme preference is persisted in `localStorage`
- **HTML Text Editor** — visual text editor at `/editor`
  - Upload an `.html` file or paste raw HTML
  - Preview the rendered page in an interactive iframe
  - Hover over any text element to see a popover with an "Edit" action
  - Click to edit text inline, then save changes live in the preview
  - Click "Generate HTML" to produce clean output with all edits applied
  - Copy the result to clipboard or download as `index.html`
  - Entirely client-side — nothing is published or saved to the server
- **Short slugs** (e.g. `quick-apple-42`) for canonical URLs like `https://quick-apple-42.sites.example.net/`
- **Update an existing site** — replace a site's entire published file set through its original URL. Settings (title, password, owner token, creation date, expiration), the slug, and the URL stay the same; files omitted from the replacement stop being served. See `PUT /api/uploads/[slug]/content` and the `/update/[slug]` form.
- **AI Builder (optional)** — signed in with Build Mode enabled, open the landing page's **Build** tab, describe a static site, and an operator-configured OpenAI-compatible model generates text files in a private per-account workspace that you can then **Preview** as a real new upload. Configure the provider in **Admin → AI** or through `JOLT_AI_*`; hidden and `503` when unconfigured. See [AI Builder](#ai-builder).
- **Origin isolation** — uploaded HTML is served only from `JOLT_SITE_BASE_ORIGIN` (e.g. `https://sites.example.net`), never from the app origin, so uploaded scripts cannot call the dashboard or APIs. Legacy `/view/[slug]` app links redirect to the canonical hosted URL.
- **Static serving** — the hosted root serves the site's entry `index.html` (or rendered Markdown); any other path serves assets (CSS, JS, images) with correct `Content-Type`
- **Password protection** — optional password per paste; visitors see a Jolt-owned unlock page; you get a shareable **unlock URL** (`?unlock=TOKEN`) so they can view without typing the password
- **Optional site data API** — a password-protected site can opt in to a private SQLite-backed JSON record API at `/_jolt/data/v1/...`. Unlock links get read-only access; entering the password grants read/write for that site's records. See [docs/jolt-data-api.md](docs/jolt-data-api.md).
- **Expiration** — optional auto-delete: `1h`, `8h`, `24h`, `1w`, or `1d`
- **Owner token** — returned once on create in the JSON response; use it to replace files, update password or expiration, or delete the site via API
- **Admin dashboard** — list uploads (filter by date, password-protected), delete pastes, set/clear passwords, toggle site data, manage **API tokens** for programmatic uploads
- **Rate limit** — 25 uploads per IP per hour (sliding window)

## Authentication

- **Anonymous API uploads are disabled.** To create pastes/upload files you must use either:
  - **Web** — upload at `/`, paste HTML at `/paste`, or paste Markdown at `/markdown`; a session cookie is set so the browser can upload.
  - **API token** — create tokens in the admin dashboard; send `Authorization: Bearer jolt_xxxxxxxx...` on `POST /api/upload`, `POST /api/paste`, or `POST /api/markdown`.
- Set **`REGISTERED_USERS_ONLY=true`** to enable login and require a logged-in user account for all three publishing endpoints. Anonymous web sessions and API tokens alone cannot upload in this mode. Registration is enabled by default; set **`ENABLE_REGISTRATION=false`** to prevent public sign-up while still allowing existing users and admin-created accounts to log in. Set a unique `JOLT_USER_SECRET` for signed user sessions.
- Viewing is separate from publishing: sites without a password remain publicly accessible at their canonical hosted URL (including their assets), even when `REGISTERED_USERS_ONLY=true`. Password-protected sites still require the site password or unlock link; viewers do not need a registered account.
- The `/dashboard` route accepts either a registered-user session (showing that user's uploads and account settings) or an admin session (showing all uploads). Admin credentials continue to use `/admin/login` and do not act as a registered-user session for publishing.
- Set **`ENABLE_LANDING_PAGE=false`** to show visitors a minimal logo and GitHub link at `/`. Logged-in registered users still see the upload form there; login, admin, and public site links remain available.

## API

### Create content

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/upload` | Web session or API token; user login when restricted | `multipart/form-data`: `file` (`.html`, `.md`, or `.zip`), optional `password`, `expiration` (`1h`, `8h`, `24h`, `1w`, `1d`). Returns `slug`, the canonical `url` on the hosted origin, `entry_point`, `owner_token`, and (if password set) `url_with_unlock`. |
| `POST` | `/api/paste` | Web session or API token; user login when restricted | JSON body: `html`, optional `password`, `expiration`. Same return shape as upload. |
| `POST` | `/api/markdown` | Web session or API token; user login when restricted | JSON body: `markdown`, optional `password`, `expiration`. Renders as a themed HTML page when viewed. Same return shape as upload. |

Upload size limit: default 25MB; set **`NUXT_JOLTHOST_UPLOAD_MAX_BYTES`** (bytes) to change (e.g. `52428800` for 50MB).

### Replace an existing site's content

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `PUT` | `/api/uploads/[slug]/content` | Owner (user login, owner token, or admin) | `multipart/form-data`: `file` (`.html`, `.md`, or `.zip`) and optional `owner_token`. Replaces the **entire** published file set. Returns the unchanged `slug` and canonical `url` plus the new `entry_point`. Existing title, password, owner token, `created_at`, and `expires_at` are preserved; updating does not restart expiration and never issues a new owner token. |
| `PUT` | `/api/uploads/[slug]/data` | Owner (user login, owner token, or admin) | JSON body `{ "enabled": true \| false }`. Opts the site in or out of the site data API. Returns `{ slug, data_enabled }`. `409` when enabling a site that has no password; `503` when the deployment cannot host isolated origins. See [docs/jolt-data-api.md](docs/jolt-data-api.md). |

Ownership is checked against the target site, not the request's general upload credentials:

- A signed-in user can update a site they own.
- An admin session can update any site.
- In open publishing mode (default), a site's owner token authorizes an update.
- A web upload session or API token is **not** ownership proof and cannot update someone else's site.
- With `REGISTERED_USERS_ONLY=true`, an owner token alone is insufficient — a logged-in user is still required. For an older anonymous upload in that mode, both a login and its owner token are required.

Send the owner token as a form field, never in the URL. The same rate limit, size policy, and CAPTCHA policy as creation apply; an API token only keeps its CAPTCHA exemption when the request also proves ownership via `owner_token`.

Errors: `400` invalid file or ZIP, `401` unauthenticated, `403` insufficient ownership, `404` missing or expired site, `409` concurrent update, `413` oversized file, `429` rate limited.

Note: `/api/paste` and `/api/markdown` create single-file pastes and are not used for replacements. Replacing is a full swap: a ZIP replacement removes the previous `index.md` or single `index.html` too.

### Manage a paste (owner token)

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| `POST` | `/api/paste/[slug]/password` | `{ owner_token, password }` | Set or change password. |
| `POST` | `/api/paste/[slug]/expiration` | `{ owner_token, expiration }` | Set expiration (`1h`, `8h`, `24h`, `1w`, `1d`) or omit/empty to clear. |

### Admin (requires admin session)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/admin/login` | Log in (body: `password`). |
| `POST` | `/api/admin/logout` | Log out. |
| `GET` | `/api/admin/uploads` | List uploads (query: `page`, `dateFrom`, `dateTo`, `protected`). |
| `GET` | `/api/admin/tokens` | List API tokens. |
| `POST` | `/api/admin/tokens` | Create token (body: `nickname`); returns `token` once. |
| `POST` | `/api/admin/tokens/delete` | Delete token (body: `id`). |
| `POST` | `/api/admin/paste/[slug]/delete` | Delete paste and its files. |
| `POST` | `/api/admin/paste/[slug]/password` | Set/clear password (body: `password`); no owner token needed. |

More detail and examples: [docs/how-to-use-upload-endpoint.md](docs/how-to-use-upload-endpoint.md).

## Data

- **Database** — `./data/jolt.db` (SQLite). Tables include `uploads`, `api_tokens`, `users` (including the default-off `ai_build_enabled` flag), `ai_settings` (singleton provider settings with an encrypted key), `ai_workspaces`, and `ai_messages` (per-account workspace pointer plus one row per stored chat message with model, token, and duration usage). AI tables and the additive user flag are initialized automatically, even before the provider is configured.
- **Site data** — one SQLite file per data-enabled site at `./data/sites/<upload-id>.sqlite` (plus `-wal`/`-shm`), created lazily on the first authorized write. These files are never served over HTTP and are deleted with their site. Back them up with SQLite's consistent backup, not a raw copy; see [docs/jolt-data-api.md](docs/jolt-data-api.md).
- **Files** — new uploads are stored as `./storage/[slug]/`. After an update, the current file set lives under `./storage/.content/[slug]/[generation-id]/`, and the row's `entry_point` points at the active generation. Replaced generations are moved to `./storage/.trash/` for a short grace period, and abandoned staging under `./storage/.staging/` is pruned by the scheduled cleanup task. AI Builder workspaces live under `./storage/.workspaces/<user-id>/`; they are never served and upload cleanup never prunes them (deleting the account removes them).
- **Notes example** — upload `examples/notes/index.html` with site data enabled for a responsive notes workspace with colored cards, grid/list layouts, dark mode, and reduced-motion-aware animations. Viewing and editing still use Jolt's existing site-data access rules.
  DM Sans loads from Google Fonts with a system-font fallback. A plain static server previews the interface but does not provide the `/_jolt/data` endpoints.

## AI Builder

> **Optional.** Enabled only when a valid provider key, Base URL, and Model resolve from **Admin → AI** settings or `JOLT_AI_API_KEY`, `JOLT_AI_BASE_URL`, and `JOLT_AI_MODEL`, and `ENABLE_AI_BUILDER` is not the literal string `false`. Each admin-set field overrides its environment counterpart; clearing an admin field restores that environment fallback. Missing or invalid configuration **fails closed**: `GET /api/config` reports `aiBuilderAvailable: false`, the Build tab and dashboard link are hidden, and every `/api/ai/**` request returns `503 ai_unavailable`. The endpoint must support the fixed request contract (`stream: false`, `n: 1`, `max_tokens: 32768`, a single `finish_reason: "stop"` completion); the gateway and model are a deployment prerequisite this repository does not verify.

In **Admin → AI**, set or replace the provider's API key, enter the explicit Base URL, and choose a Model (suggestions are not a guarantee of provider support). Base URLs require HTTPS, except loopback HTTP for local providers; userinfo, query, and fragment are rejected. Save reports the effective source (`admin`, `env`, or `none`) and availability. The password field is never prefilled: only the final four key characters appear as a hint, and keys of four characters or fewer have no hint. A blank key input leaves it unchanged; **Clear stored key** removes only the database override. Empty Base URL or Model inputs also remove their admin overrides.

Stored keys use AES-256-GCM with a fresh nonce, with the encryption key derived using scrypt from `JOLT_ADMIN_SECRET ?? JOLT_VIEW_SECRET ?? 'jolt-admin-default-change-in-production'`. **Set a strong, stable secret in production and back it up securely alongside the database.** Changing that secret makes the stored key unreadable and disables the builder until an admin replaces or clears it. No plaintext provider key is returned by settings endpoints, logged, or placed in prompts/transcripts.

In **Admin → Users**, click an account's **Build Mode** badge to enable or disable access. New and existing accounts default to Disabled, including accounts that also hold an admin session. Disabled accounts do not see Build entry points; direct builder requests return `403 builder_disabled` when the server is configured. The global availability flag remains independent of account permissions, and the global kill switch always wins.

Admin settings API (admin session required): `GET /api/admin/ai/settings` returns `{ available, source, base_url, model, has_key, key_hint, ai_build_enabled_global }`; `PUT` accepts `{ base_url?, api_key?, model? }`, where null/omitted leaves a field unchanged and `""` clears its stored override. Models must be nonblank (unless clearing) and at most 200 characters; invalid Base URL/Model requests return `400 invalid_request`. User creation accepts optional `ai_build_enabled`; `PATCH /api/admin/users/[id]` accepts `0`, `1`, `false`, or `true`, and `/api/auth/me` includes the flag.

The builder is **code generation, not an agent**: one message is exactly one model call (`POST /api/ai/chat`) that must return a validated JSON manifest of file operations. There is no shell, container, package install, build step, streaming, tool call, provider fallback, or automatic retry, and generated HTML/CSS/JS never executes on the app origin — only on the isolated hosted origin after you Preview.

- **Account required** — always needs a signed-in registered account with Build Mode enabled, even when `REGISTERED_USERS_ONLY=false`. Anonymous, API-token, view-cookie, owner-token, and admin-only sessions cannot use the builder; an admin session never bypasses the account's Build Mode gate.
- **Private workspace** — one workspace per account at `./storage/.workspaces/<user-id>/`. It persists across logins and server restarts and is never served as site content. Deleting the account removes its AI rows and workspace directory.
- **Caps** — at most 50 editable files, 1 MiB per file, and 5 MiB of editable content per workspace. These caps cover the **active generated text file set** only; attached **opaque assets** are accounted separately (bounded by the existing 100 MiB archive-extraction ceiling), and workspace generations/metadata are private implementation storage, so the on-disk workspace footprint can be larger. Generated extensions are `.html`, `.css`, `.js`, `.md`, `.txt`, `.svg`, and `.json`.
- **External provider** — your message and the current editable file contents are sent to the operator-configured model endpoint so it can produce the next manifest. The API key stays server-side and is never returned, logged, or placed in prompts or transcripts; model output is treated as untrusted data. Do not paste secrets or personal data you do not want the operator's provider to receive.
- **Cost visibility** — each model call records its model, provider-reported input/output token counts, and duration in the `ai_messages` table (unknown usage is `null`; token counts are never invented). There is **no usage dashboard or billing UI** in this release — read the raw rows from the SQLite database.
- **Chat limits** — 30 accepted generation attempts per account per rolling hour (failed provider attempts still consume the budget, and a `429` includes `Retry-After`); one in-flight operation per account (further requests get `409 workspace_busy`); request bodies are capped at 8 KiB and stored messages at 16 KiB.
- **Preview publishes** — **Preview** packages the committed editable files as a ZIP and runs them through the same creation pipeline and policy as `/api/upload` (upload rate limit, CAPTCHA, size limits, password, expiration, Data API opt-in). Each Preview is a new, real, owned upload with its own slug and owner token; the workspace is **not** attached to it, so you can keep iterating and publish again. The result flow is the ordinary `/result/<slug>` page.

### Edit an existing upload

Eligible rows in the dashboard list (owned, nonanonymous, unexpired; `ai_editable: true`) get an **Edit with AI** action that opens the Build tab with `?tab=build&edit=<slug>`. Query parameters only preselect the site — you must confirm **Attach** before anything changes, and attaching replaces the current draft files and chat session.

- **Opaque assets** — attaching copies the site's live served files (`dirname(entry_point)`) into the workspace. Allowed text extensions that decode as UTF-8 without NUL are editable; everything else (images, fonts, archives, binary files with a text-looking extension) is kept as an **opaque asset**. Opaque bytes never enter the model's context and never leave the server, manifests cannot add/update/delete them, and every subsequent generation and publication carries them through byte-for-byte.
- **Attachment limits** — attaching refuses a site whose editable text exceeds the 50-file / 1 MiB-per-file / 5 MiB-total caps with `413 editable_workspace_too_large` (and `413 source_too_large` above the archive ceiling). Unsafe source layouts (symlinks, non-regular files, unsupported names) are a `400`, never silently dropped files. Attachment is all-or-nothing: a failed attach leaves the previous workspace untouched.
- **Authorization** — only the site's registered owner or a registered account holding an admin session can attach it. Anonymous owner-token sites are excluded, and a matching owner token is never sufficient anywhere in the builder.
- **Publish changes** — repackages the workspace server-side (edited text plus opaque assets) and replaces the site through the ordinary content-replacement pipeline under one upload rate limit and the current CAPTCHA policy: the **same slug, URL, upload id, title, password, expiration, and Data API state**, with no new row and no owner token. Publication does not change workspace content or revision; it only refreshes the attach baseline.
- **Conflicts** — the replacement switch uses the entry point observed at attach (or the last successful publish). If the site was replaced elsewhere in the meantime, publishing returns `409` and the UI offers an explicit reattach rather than overwriting the newer content.
- **Restore / start over** — each edit session keeps **one** private `.pre-edit-<timestamp>/` snapshot of the bytes present at attach. **Restore previous version** stages those original bytes into a new local generation only; the live site is unchanged until you explicitly publish, and no settings, expiration, or Data API records are ever restored from it. **Start a new site** clears the attachment and snapshot, starts a new session, and returns to new mode (previous transcript rows remain as cost history). The snapshot is never published or served.

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/ai/chat` | Registered account | JSON `{ message, revision }`; one validated generation turn. |
| `GET` | `/api/ai/files` | Registered account | Committed workspace state plus the newest 20 transcript rows. |
| `GET` | `/api/ai/files/[...path]` | Registered account | One editable text file as JSON (`403 opaque_file` for retained assets). |
| `POST` | `/api/ai/preview` | Registered account + upload policy | Publish the workspace as a new site; returns the creation result. |
| `POST` | `/api/ai/attach` | Registered account | JSON `{ slug, revision }`; seed the workspace from an owned (or admin-managed) existing upload plus one pre-edit snapshot. |
| `POST` | `/api/ai/restore` | Registered account | JSON `{ revision }`; stage the active session's pre-edit snapshot into a new local generation. |
| `POST` | `/api/ai/reset` | Registered account | JSON `{ revision }`; clear the attachment/snapshot and return to new mode with a new session. |
| `PUT` | `/api/uploads/[slug]/content` | Registered account (builder mode) | `multipart/form-data` with `ai_workspace_revision` (and a CAPTCHA token when enabled): server-packages the attached workspace, opaque assets included, and replaces the same site. |

All AI responses are `Cache-Control: no-store` and use the shared `{ "error": { "code", "message" } }` shape; see `server/utils/ai-http.ts` for the code vocabulary. Availability is checked before authentication, so an unconfigured server answers `503` rather than `401`; the content PUT's builder mode checks availability as soon as its multipart marker identifies the request, while its ordinary `file`/`owner_token` mode keeps its existing policy.

## Environment

See [.env.example](.env.example). Main options:

| Variable | Purpose |
|----------|---------|
| `JOLT_ADMIN_PASSWORD` or `NUXT_JOLTHOST_ADMIN_PASSWORD` | Admin dashboard password (required for `/admin`). |
| `JOLT_APP_ORIGIN` | Full app origin, e.g. `https://host.example.com`. Required in production unless it is a loopback host such as `http://localhost:3000`. |
| `JOLT_SITE_BASE_ORIGIN` | Full hosted-site base origin, e.g. `https://sites.example.net`. Required in production unless it is a loopback host such as `http://sites.localhost:3000`; needs wildcard DNS/TLS to the same service. |
| `JOLT_TRUST_PROXY` | Set to `true` behind a reverse proxy so `X-Forwarded-Host`/`X-Forwarded-For`/`CF-Connecting-IP` are trusted. |
| `JOLT_DATA_SESSION_SECRET` | Secret for signing site data-admin cookies (required for the site data feature). |
| `JOLT_VIEW_SECRET` | Secret for signing view/unlock cookies and tokens. |
| `JOLT_ADMIN_SECRET` | Secret for admin session cookie (defaults to `JOLT_VIEW_SECRET`). |
| `JOLT_WEB_SECRET` | Secret for web upload session cookie. |
| `REGISTERED_USERS_ONLY` | Set to `true` to enable login and require a logged-in user for publishing; default `false`. |
| `ENABLE_REGISTRATION` | Set to `false` to disable public sign-up when registered-only uploads are enabled; default `true`. |
| `ENABLE_LANDING_PAGE` | Set to `false` to show visitors only the logo and GitHub link at `/`; logged-in users see the uploader. Default `true`. |
| `JOLT_USER_SECRET` | Secret for signed user login cookies (set a unique value in production). |
| `NUXT_JOLTHOST_UPLOAD_MAX_BYTES` | Max upload size in bytes (default 25MB). |
| `JOLT_AI_API_KEY` | Fallback operator key when no admin key is stored. Server-side only; never exposed. |
| `JOLT_AI_BASE_URL` | Fallback OpenAI-compatible API base ending in `/v1` (absolute HTTPS; loopback HTTP allowed for local/mock use). |
| `JOLT_AI_MODEL` | Fallback provider model identifier when no admin model is stored. |
| `ENABLE_AI_BUILDER` | Kill switch; disabled only by the literal string `false`. Otherwise enabled when effective admin/environment settings are valid; account access separately requires Build Mode. |

## Docker / VPS deployment

Build and run with Docker (data and uploads persist in named volumes):

```bash
docker compose up -d --build
```

When changing dependencies, regenerate and commit `package-lock.json` with the same npm major as
the `node:20-bookworm` builder (currently npm 10). Docker uses `npm ci`, which rejects lockfiles
missing resolved optional peer dependencies.

App is at [http://localhost:3000](http://localhost:3000), and uploaded sites are served locally at
`http://<slug>.sites.localhost:3000` (`*.localhost` resolves to loopback in browsers). Compose
defaults `JOLT_APP_ORIGIN` and `JOLT_SITE_BASE_ORIGIN` to those loopback origins, and loopback
origins are allowed to use `http` even though the container runs in production mode. Publishing on a
different port? Point both origins (and the port mapping) at the port you browse.

On a VPS, put a reverse proxy (e.g. Caddy or Nginx) in front, set `JOLT_APP_ORIGIN` and
`JOLT_SITE_BASE_ORIGIN` to your HTTPS origins on **different registrable domains**, point wildcard
DNS (`*.sites.example.net`) at the proxy, and terminate a wildcard TLS certificate there. With no
origins configured, the app answers only on loopback hosts and 404s every other host, so a
misconfigured deployment never serves the dashboard on the hosted domain. The proxy must pass the
original `Host` and `Origin` headers through unchanged — see
[docs/jolt-data-api.md](docs/jolt-data-api.md#before-you-can-enable-it-operator).

## Scripts

- `npm run dev` — dev server
- `npm run build` — production build
- `npm run preview` — preview production build
- `npm run test` — run all tests
- `npm run test:unit` — unit tests (server)
- `npm run test:integration` — integration tests
- `npm run test:fixtures` — rebuild test fixtures (e.g. dummy ZIP)
- `node scripts/build-escape-fixture.mjs` — rebuild the path-escaping ZIP fixture used by security tests
