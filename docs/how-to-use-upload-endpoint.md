# How to Use the Upload & Paste Endpoints

Upload HTML files, Markdown files, or ZIP archives — or paste raw HTML/Markdown — to host them and get a shareable link.

## Endpoints

| Endpoint | Content-Type | Description |
|----------|-------------|-------------|
| `POST /api/upload` | `multipart/form-data` | Upload an `.html`, `.md`, or `.zip` file |
| `POST /api/paste` | `application/json` | Paste raw HTML as a hosted page |
| `POST /api/markdown` | `application/json` | Paste raw Markdown as a rendered, themed page |
| `PUT /api/uploads/[slug]/content` | `multipart/form-data` | Replace the entire published file set of an existing site |
| `PUT /api/uploads/[slug]/data` | `application/json` | Opt a password-protected site in or out of the [site data API](jolt-data-api.md) |

## Authentication

**Anonymous uploads via the API are disabled.** You must use one of:

1. **Web form** – Visit `/` in a browser to upload. A session cookie is set automatically.
2. **API token** – Include the token in the `Authorization` header for programmatic uploads:

```
Authorization: Bearer jolt_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Tokens are created in the admin dashboard at `/admin`.

When `REGISTERED_USERS_ONLY=true`, publishing requires either a logged-in registered-user session cookie **or** a valid API token. An API token authorizes programmatic uploads without logging in, so token-based automation keeps working in restricted mode. A web session cookie alone cannot publish.

Register at `/register` if sign-up is enabled; when `ENABLE_REGISTRATION=false`, an admin must create your account.

## `/api/upload` — File Upload

**Content-Type:** `multipart/form-data`

| Field        | Type   | Required | Description                                                                  |
|--------------|--------|----------|------------------------------------------------------------------------------|
| `file`       | File   | Yes      | An `.html` file, `.md` file, or `.zip` archive containing a static site      |
| `password`   | String | No       | Password to protect the paste (max 200 chars)                                |
| `expiration` | String | No       | Auto-delete after: `1h`, `8h`, `24h`, `1w`, or `1d` (e.g. `24h` = 24 hours)  |
| `enable_data` | String | No      | `true` to enable the [site data API](jolt-data-api.md) at creation. Requires `password` (400 without one), fails `503` when the deployment cannot host the data feature, and `403` when `ENABLE_DATA_API_TOGGLE=false`. |

**Limits**

- **File size:** 25MB (configurable via `NUXT_JOLTHOST_UPLOAD_MAX_BYTES`)
- **Rate limit:** 25 uploads per IP per hour
- **Accepted formats:** `.html`, `.md`, or `.zip`
- **ZIP requirement:** Must contain at least one `.html` file; `index.html` is used as entry point if present
- **Markdown:** `.md` files are stored as `index.md` and rendered server-side to HTML with a theme switcher when viewed

## `/api/paste` — Paste Raw HTML

**Content-Type:** `application/json`

| Field        | Type   | Required | Description                          |
|--------------|--------|----------|--------------------------------------|
| `html`       | String | Yes      | Raw HTML content                     |
| `password`   | String | No       | Password to protect the paste        |
| `expiration` | String | No       | Auto-delete after: `1h`, `8h`, `24h`, `1w`, `1d` |

## `/api/markdown` — Paste Raw Markdown

**Content-Type:** `application/json`

| Field        | Type   | Required | Description                                                           |
|--------------|--------|----------|-----------------------------------------------------------------------|
| `markdown`   | String | Yes      | Raw Markdown content                                                  |
| `password`   | String | No       | Password to protect the paste                                         |
| `expiration` | String | No       | Auto-delete after: `1h`, `8h`, `24h`, `1w`, `1d`                    |

Markdown pastes are rendered server-side and displayed with a floating theme switcher (GitHub, Dracula, Solarized, Nord). The viewer's theme preference is stored in `localStorage`.

## `PUT /api/uploads/[slug]/content` — Replace a site

Replaces the **entire** published file set for an existing site while keeping its row, slug, and canonical hosted URL. Files omitted from the replacement stop being served; there is no version history or rollback.

**Content-Type:** `multipart/form-data`

| Field         | Type   | Required | Description                                                                 |
|---------------|--------|----------|-----------------------------------------------------------------------------|
| `file`        | File   | Yes      | An `.html` file, `.md` file, or `.zip` archive containing the full new site |
| `owner_token` | String | No       | The site's owner token, when ownership is not proven by a login or admin session |

**What stays the same:** the slug, the canonical hosted URL, title, password (and its unlock link), owner token, `created_at`, and `expires_at`. The Data API state is untouched too — records and the enabled/disabled toggle survive replacement. Updating content does not restart expiration and never issues a new owner token. The response contains only `slug`, `url`, and `entry_point` — the owner token is never echoed back.

**What changes:** the stored file set and the `entry_point`. A ZIP's entry point is chosen the same way as at creation (`index.html` at the root first, otherwise the first HTML file alphabetically, including nested paths).

**Authorization**

- A signed-in user can update a site they own.
- An admin session can update any site.
- In open publishing mode (default), a site's owner token authorizes an update.
- An API token is **not** ownership proof: it authenticates the client, but a site is still only replaceable with its owner token, a matching login, or an admin session.
- With `REGISTERED_USERS_ONLY=true`, an API token counts as an authenticated client, so a valid API token plus the site's `owner_token` can replace a site without logging in. Without an API token, an owner token alone is insufficient and a login is still required.

Pass `owner_token` as a form field, never in the URL or query string.

**Limits**

- Same size policy as creation: per-user limit, then 100MB for API uploads, 5MB for anonymous ZIPs, otherwise `NUXT_JOLTHOST_UPLOAD_MAX_BYTES` (default 25MB).
- Same rate limit (25 uploads per IP per hour) and CAPTCHA policy as creation. An API token keeps its CAPTCHA exemption only when the request also proves ownership via `owner_token`.

**Safety**

- The replacement is written to a staging directory outside the served asset root, validated, then moved into place. The database pointer change is the publication switch.
- If validation or publication fails, the previous site keeps working.
- A ZIP is rejected if any entry escapes the target directory, if it expands beyond the extraction bound, or if it contains no `.html` file.

**Errors**

| Status | Meaning |
|--------|---------|
| 400 | Invalid or unsupported file, unsafe ZIP, or CAPTCHA failure |
| 401 | Not authenticated (or, in restricted mode, an owner token without a login or API token) |
| 403 | Authenticated but not the owner |
| 404 | Site not found or expired |
| 409 | A concurrent update changed the site first |
| 413 | File or expanded ZIP exceeds the size limit |
| 429 | Rate limit exceeded (check `Retry-After`) |

### Example

```bash
# Replace the files at quick-dragon-42, keeping the same URL
curl -X PUT https://host.example.com/api/uploads/quick-dragon-42/content \
  -F "file=@./site-v2.zip" \
  -F "owner_token=abc123..."

# As the signed-in owner, no owner token needed
curl -X PUT https://host.example.com/api/uploads/quick-dragon-42/content \
  -b cookies.txt \
  -F "file=@./site-v2.zip"
```

```javascript
const formData = new FormData()
formData.append('file', fileInput.files[0])
formData.append('owner_token', 'abc123...') // omit when logged in as the owner

const res = await fetch('https://host.example.com/api/uploads/quick-dragon-42/content', {
  method: 'PUT',
  body: formData,
})
const { slug, url, entry_point } = await res.json()
```

## Examples

### cURL

```bash
# Upload an HTML file
curl -X POST https://host.example.com/api/upload \
  -H "Authorization: Bearer jolt_YOUR_TOKEN_HERE" \
  -F "file=@./index.html"

# Upload a Markdown file
curl -X POST https://host.example.com/api/upload \
  -H "Authorization: Bearer jolt_YOUR_TOKEN_HERE" \
  -F "file=@./notes.md"

# Upload a ZIP with password, expiration, and the Data API enabled
curl -X POST https://host.example.com/api/upload \
  -H "Authorization: Bearer jolt_YOUR_TOKEN_HERE" \
  -F "file=@./site.zip" \
  -F "password=my-secret" \
  -F "expiration=24h" \
  -F "enable_data=true"

# Paste raw HTML
curl -X POST https://host.example.com/api/paste \
  -H "Authorization: Bearer jolt_YOUR_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{"html": "<h1>Hello</h1>", "expiration": "1w"}'

# Paste raw Markdown
curl -X POST https://host.example.com/api/markdown \
  -H "Authorization: Bearer jolt_YOUR_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{"markdown": "# Hello\n\nThis is **markdown**.", "expiration": "1w"}'
```

### JavaScript (fetch)

```javascript
const token = 'jolt_YOUR_TOKEN_HERE'
const headers = { 'Authorization': `Bearer ${token}` }

// Upload a file (.html, .md, or .zip)
const formData = new FormData()
formData.append('file', fileInput.files[0])
formData.append('expiration', '1w')

const uploadRes = await fetch('https://host.example.com/api/upload', {
  method: 'POST',
  headers,
  body: formData,
})
console.log((await uploadRes.json()).url)

// Paste raw Markdown
const mdRes = await fetch('https://host.example.com/api/markdown', {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ markdown: '# Hello\n\nWorld', expiration: '24h' }),
})
console.log((await mdRes.json()).url)
```

### Python (requests)

```python
import requests

headers = {'Authorization': 'Bearer jolt_YOUR_TOKEN_HERE'}

# Upload a Markdown file
with open('notes.md', 'rb') as f:
    response = requests.post(
        'https://host.example.com/api/upload',
        headers=headers,
        files={'file': ('notes.md', f, 'text/markdown')},
        data={'expiration': '24h'},
    )
print(response.json()['url'])

# Paste raw Markdown
response = requests.post(
    'https://host.example.com/api/markdown',
    headers=headers,
    json={'markdown': '# Hello\n\nWorld', 'expiration': '1w'},
)
print(response.json()['url'])
```

### Postman

Import the collection from `docs/postman-upload-collection.json`:

1. Open Postman → **Import** → select the JSON file
2. Set collection variables: **baseUrl** (e.g. `http://localhost:3000`), **apiToken** (your token from `/admin`)
3. For file uploads: In the Body tab, choose **form-data**, add a `file` key, change type to **File**, and select your `.html`, `.md`, or `.zip`
4. For markdown paste: In the Body tab, choose **raw → JSON**, and send `{ "markdown": "# Your content" }`
5. Optionally add `password` and `expiration` fields

## Response

The create endpoints (`/api/upload`, `/api/paste`, `/api/markdown`) return the same shape on success (200):

```json
{
  "slug": "quick-dragon-42",
  "url": "https://quick-dragon-42.sites.example.net/",
  "entry_point": "quick-dragon-42/index.md",
  "owner_token": "abc123...",
  "url_with_unlock": "https://quick-dragon-42.sites.example.net/?unlock=TOKEN",
  "data_enabled": "true"
}
```

- **slug** — unique identifier for the paste
- **url** — canonical public URL, on the hosted-site origin (`<slug>.<JOLT_SITE_BASE_ORIGIN host>/`)
- **entry_point** — path to the stored file (`index.html`, `index.md`, or the ZIP entry point)
- **owner_token** — use to update password or expiration via `/api/paste/[slug]/password` and `/api/paste/[slug]/expiration`, to replace files, or to delete the site. It is returned only in this response and never appears in a URL.
- **url_with_unlock** — *(only when password set)* shareable URL with a signed token that auto-unlocks the page for viewing; expires when the paste expires (or in 30 days if no expiration). It grants read-only access to a data-enabled site.
- **data_enabled** — *(only when the Data API was enabled at creation)* confirms the site's data API is on; it can be switched off later with `PUT /api/uploads/[slug]/data`.

The replacement endpoint (`PUT /api/uploads/[slug]/content`) returns a smaller shape (200):

```json
{
  "slug": "quick-dragon-42",
  "url": "https://quick-dragon-42.sites.example.net/",
  "entry_point": ".content/quick-dragon-42/8f2c.../index.html"
}
```


## Error Responses

| Status | Meaning |
|--------|---------|
| 400 | Missing or empty content, unsupported file format, invalid expiration, or password too long |
| 401 | No valid web session or API token, or neither a registered-user session nor an API token when `REGISTERED_USERS_ONLY=true` |
| 403 | Authenticated but not permitted (e.g. replacing a site you do not own) |
| 404 | Site not found or expired (replacement endpoint) |
| 409 | Concurrent update detected (replacement endpoint) |
| 413 | Content exceeds size limit |
| 429 | Rate limit exceeded (check `Retry-After` header) |

## API Tokens

Tokens may be created in two places:

- Registered users create and revoke their own tokens under **Dashboard → Account Settings → API tokens** (`GET/POST /api/user/tokens`, `POST /api/user/tokens/delete`).
- Admins create tokens in the **API Tokens** tab at `/admin` (`POST /api/admin/tokens`), optionally assigning an owner with `user_id`.

Send a token in the `Authorization` header:

```
Authorization: Bearer jolt_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**Ownership and attribution.** A token can be owned by a registered user. Uploads made with an owned token are attributed to that user, so they appear in that user's dashboard ("My Uploads"). A token with no owner still authorizes uploads, but the resulting sites are unattributed and appear only in the admin dashboard. Token ownership is unrelated to *replacing* a site: the `owner_token` (or a matching login/admin session) is still what authorizes an update.

See the examples above for cURL, JavaScript, and Python usage.
