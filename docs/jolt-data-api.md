# Jolt Host Site Data API

Optional, password-gated JSON storage for a **static** upload. Your site stays a plain
HTML/CSS/JS file set — no server code runs, and there is no SQL endpoint. Each data-enabled
site gets one private SQLite file on the server and talks to it over a small JSON API.

## Before you can enable it (operator)

Site data requires an **isolated hosted origin** so uploaded JavaScript never shares an origin
with your dashboard, APIs, or admin cookies:

| Variable | Example | Meaning |
|---|---|---|
| `JOLT_APP_ORIGIN` | `https://host.example.com` | Full origin of the Jolt Host app. |
| `JOLT_SITE_BASE_ORIGIN` | `https://sites.example.net` | Full origin of the site base domain (no wildcard). |
| `JOLT_DATA_SESSION_SECRET` | 32+ random bytes | Signs data-admin cookies; keep separate from `JOLT_VIEW_SECRET`. |
| `JOLT_VIEW_SECRET` | 32+ random bytes | Signs view/unlock credentials. Required, and must not be the built-in default, in production. |

Canonical site URLs are `<slug>` prefixed to the base origin's hostname:
`https://quick-dragon-42.sites.example.net/`. In development the defaults are
`http://localhost:3000` (app) and `http://sites.localhost:3000` (sites).

Requirements and constraints:

- The hosted base must be a **different registrable domain** from the app origin (checked with a
  public-suffix list, not a string suffix). `host.example.com` + `sites.example.com` is rejected.
  `localhost` / `sites.localhost` (loopback) is always accepted and is what local Docker and
  `npm run preview` use.
- **Wildcard DNS** `*.sites.example.net` → the same Node service (or its reverse proxy), and a
  **wildcard TLS certificate** (`*.sites.example.net` or `*.example.net`) so every site host is
  served over HTTPS. A proxy must pass the original `Host` header through unchanged, and must not
  strip or rewrite the `Origin` header. `JOLT_TRUST_PROXY=true` additionally trusts
  `X-Forwarded-Host`/`X-Forwarded-For`/`CF-Connecting-IP` for host and client-IP detection.
- Production must use HTTPS for public origins (loopback origins may use `http`, so the local
  container works). Without valid origins and secrets the data feature fails closed
  (enabling returns `503`) and legacy `/view/<slug>` links return `503`; nothing is exposed on a
  shared origin.
- Multiple app replicas cannot share SQLite data files. Run one instance, or accept that data is
  per-replica. The in-memory rate limits are also per process — put a shared limiter at the edge
  if you scale out.

### Backups

The databases live in `data/sites/<upload-id>.sqlite` with `-wal`/`-shm` sidecars, and they use
WAL mode. Copying just the `.sqlite` file can lose recent commits. Write consistent snapshots to a
directory that is **outside** `data/sites`: the app deletes `data/sites/<uuid>.sqlite*` when a site
is deleted or expires, and it never touches, indexes, or serves your backup directory.

```bash
# Consistent, WAL-inclusive snapshot of every site database into a protected dir
BACKUP_DIR=/var/backups/jolthost/sites   # outside data/ and storage/
install -d -m 0700 "$BACKUP_DIR"
for db in data/sites/*.sqlite; do
  id="$(basename "$db" .sqlite)"
  sqlite3 "$db" ".backup '$BACKUP_DIR/${id}-$(date -u +%Y%m%dT%H%M%SZ).sqlite'"
done
# prune on your own schedule
find "$BACKUP_DIR" -type f -name '*.sqlite' -mtime +30 -delete
```

Retention is the operator's decision and it deliberately outlives site deletion: deleting or
expiring a site removes its live database, but snapshots you took of it remain in your backup
directory until you delete or rotate them. Keep that directory on encrypted storage with restricted
permissions and treat it as containing whatever your visitors submitted. Never mount or publish
`data/` (or a backup directory) into a served/static directory, and never put a database inside
`storage/`, `public/`, or an uploaded ZIP.

## Enabling data for a site

Data is opt-in, per site, and only for sites that have a password:

```bash
# As the signed-in owner (session cookie) — or with the site's owner_token
curl -X PUT https://host.example.com/api/uploads/quick-dragon-42/data \
  -H 'Content-Type: application/json' \
  -b cookies.txt \
  -d '{"enabled": true}'
```

- `200` → `{"slug":"quick-dragon-42","data_enabled":true}`
- `409` → the site has no password yet
- `503` → the deployment cannot host isolated origins/secrets
- `403`/`401` → the caller is not the site's owner or an admin

Ownership uses the same rules as replacing content: a signed-in owner, an admin session, or the
site's `owner_token`. A view cookie, unlock link, data session, API token alone, or app login is
**not** ownership proof. The dashboard at `/dashboard` has an enable/disable control per site.

Disabling blocks reads and writes but **keeps every record**. Clearing the site password disables
data too (records are kept). Setting a new password and re-enabling reveals the *same* records to
whoever holds the new password — there is one shared dataset per site, not per visitor.

## Who can do what

| Credential | Read records | Write records | Manage the site (replace/delete/password) |
|---|---|---|---|
| Unlock link (`?unlock=…`) or its view cookie | ✅ | ❌ | ❌ |
| Site password submitted on the Jolt form | ✅ | ✅ | ❌ |
| Site `owner_token` / owner login / admin | — | — | ✅ |
| API upload token | ❌ | ❌ | Only with owner proof |

A password is a **shared data-admin credential**: every holder can edit everyone's records. There
is no per-visitor privacy and no audit trail. `HttpOnly` cookies stop client scripts from *reading*
the credential, but a script running on the site can still issue same-origin requests as the signed-in
holder — only embed scripts you trust.

## API

Base: `https://<slug>.<hosted-base>/_jolt/data/v1`

| Method | Path | Auth | Result |
|---|---|---|---|
| `GET` | `/collections/<collection>/items?limit=&offset=` | view or data session | `200 {"items":[…],"next_offset":number\|null}` |
| `POST` | `/collections/<collection>/items` | data session | `201` item |
| `PATCH` | `/collections/<collection>/items/<id>` | data session | `200` item (value replaced whole) |
| `DELETE` | `/collections/<collection>/items/<id>` | data session | `204` |

- Item shape: `{"id":"<uuid>","value":{…},"created_at":"ISO","updated_at":"ISO"}`.
- Collections match `^[a-z][a-z0-9_-]{0,39}$`; at most **10 collections**, **1,000 records**,
  **4 KiB** of JSON per record, and **1 MiB** of stored payload per site.
- Lists default to 50 items, max 100, ordered by `(created_at, id)`; `offset` must be ≥ 0.
- `value` must be a JSON **object** — never a SQL string, table, or schema instruction.
- Request bodies are capped at 8 KiB before parsing. Responses use `Cache-Control: no-store`.
- Status codes: `400` invalid input, `401` no credentials (JSON includes `login_url`),
  `403` view-only session attempting a write or bad `Origin`, `404` unknown/disabled/expired site or
  record, `409` quota reached, `413` too large, `429` rate limited (with `Retry-After`).
- Mutations require same-origin proof and `Content-Type: application/json`: either an exact
  matching `Origin` header, or — because browsers send `Origin: null` (or omit it) on same-origin
  form POSTs — an absent/`null` Origin together with the browser-set `Sec-Fetch-Site: same-origin`
  header. A cross-site `Origin`, or a missing one with no Fetch metadata, is rejected. Cross-origin
  credentialed CORS is not offered.

### Signing in for writes

Writes need a **data-admin session**, issued only by Jolt's own password form:

- `GET /_jolt/data/login` — Jolt-owned password form (shown even if the visitor already unlocked
  the site with a link).
- `POST /_jolt/data/login` — verifies the password from the form body, then sets a host-only,
  `HttpOnly`, `SameSite=Strict` cookie scoped to `/_jolt/data` and redirects (`303`) to `/`.
- The normal site unlock form (`/_jolt/unlock`) grants the same data session when the site has data
  enabled.
- A successful sign-in also mints the normal view cookie, so it unlocks the site itself.

The data session lasts 24 hours and is bound to the site's current password hash: changing the
password revokes it immediately. Unlock links are view-only and never become write credentials.

### Rate limits (per site, in memory)

| Limit | Window |
|---|---|
| 5 failed passwords per IP | 15 minutes |
| 50 password attempts | 15 minutes |
| 60 writes per data session | 1 minute |
| 120 API requests | 1 minute |

## Static sample: shared to-do list

Paste this into a data-enabled site (e.g. as `index.html`). It reads on load, adds, toggles, and
deletes items, and offers the sign-in link when a write is refused. It never embeds a password or
token, and it renders user text with `textContent` — never `innerHTML`.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Shared to-do list</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0 auto; padding: 2rem; max-width: 32rem; }
    form { display: flex; gap: .5rem; margin-bottom: 1rem; }
    input[type="text"] { flex: 1; padding: .5rem; }
    li { display: flex; align-items: center; gap: .5rem; padding: .35rem 0; }
    li span { flex: 1; }
    .muted { color: #666; font-size: .85rem; }
    .done { text-decoration: line-through; color: #888; }
  </style>
</head>
<body>
  <h1>Shared to-do list</h1>
  <p class="muted" id="status"></p>

  <form id="add-form">
    <input type="text" id="new-title" placeholder="What needs doing?" maxlength="200" required>
    <button type="submit">Add</button>
  </form>

  <ul id="list"></ul>
  <p id="signin" hidden><a href="/_jolt/data/login">Sign in to edit this list</a></p>

  <script>
    const COLLECTION = 'todos'
    const ITEMS = `/_jolt/data/v1/collections/${COLLECTION}/items`
    const status = document.getElementById('status')
    const list = document.getElementById('list')
    const signin = document.getElementById('signin')

    function setStatus(text) { status.textContent = text || '' }

    function render(items) {
      list.textContent = ''
      if (items.length === 0) {
        const empty = document.createElement('li')
        empty.className = 'muted'
        empty.textContent = 'Nothing here yet.'
        list.append(empty)
        return
      }
      for (const item of items) {
        const row = document.createElement('li')

        const checkbox = document.createElement('input')
        checkbox.type = 'checkbox'
        checkbox.checked = item.value.done === true
        checkbox.addEventListener('change', () => {
          patch(item.id, { ...item.value, done: checkbox.checked })
        })

        const label = document.createElement('span')
        label.textContent = String(item.value.title ?? '')
        if (item.value.done === true) label.className = 'done'

        const remove = document.createElement('button')
        remove.type = 'button'
        remove.textContent = 'Delete'
        remove.addEventListener('click', () => removeItem(item.id))

        row.append(checkbox, label, remove)
        list.append(row)
      }
    }

    async function handle(response) {
      if (response.status === 401 || response.status === 403) {
        signin.hidden = false
        setStatus('You can read this list but not change it.')
        return null
      }
      if (!response.ok && response.status !== 204) {
        setStatus(`Request failed (${response.status}).`)
        return null
      }
      signin.hidden = true
      return response.status === 204 ? {} : response.json()
    }

    async function load() {
      const data = await handle(await fetch(ITEMS, { headers: { Accept: 'application/json' } }))
      if (data) render(data.items)
    }

    async function add(title) {
      const created = await handle(await fetch(ITEMS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: { title, done: false } }),
      }))
      if (created) await load()
    }

    async function patch(id, value) {
      const updated = await handle(await fetch(`${ITEMS}/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      }))
      if (updated) await load()
    }

    async function removeItem(id) {
      await handle(await fetch(`${ITEMS}/${id}`, { method: 'DELETE' }))
      await load()
    }

    document.getElementById('add-form').addEventListener('submit', (event) => {
      event.preventDefault()
      const input = document.getElementById('new-title')
      const title = input.value.trim()
      if (!title) return
      input.value = ''
      add(title)
    })

    load()
  </script>
</body>
</html>
```

Reload the page and the list is still there — it lives on the server, not in the browser.

## Lifecycle

- **Replacing a site's files** (ZIP/HTML/Markdown) never touches its database.
- **Disabling** data hides the API (reads and writes return `404`) but keeps the records.
- **Clearing the password** disables data as well and revokes existing data sessions; records stay.
- **Changing the password** keeps data enabled and reveals the same records to the new holders.
- **Deleting or expiring a site** deletes its records, its database file, and its WAL sidecars.
  Orphaned database files from interrupted deletes are reconciled by the scheduled cleanup task.
