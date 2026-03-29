# How to Use the Upload & Paste Endpoints

Upload HTML files, Markdown files, or ZIP archives — or paste raw HTML/Markdown — to host them and get a shareable link.

## Endpoints

| Endpoint | Content-Type | Description |
|----------|-------------|-------------|
| `POST /api/upload` | `multipart/form-data` | Upload an `.html`, `.md`, or `.zip` file |
| `POST /api/paste` | `application/json` | Paste raw HTML as a hosted page |
| `POST /api/markdown` | `application/json` | Paste raw Markdown as a rendered, themed page |

## Authentication

**Anonymous uploads via the API are disabled.** You must use one of:

1. **Web form** – Visit `/` in a browser to upload. A session cookie is set automatically.
2. **API token** – Include the token in the `Authorization` header for programmatic uploads:

```
Authorization: Bearer jolt_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Tokens are created in the admin dashboard at `/admin`.

## `/api/upload` — File Upload

**Content-Type:** `multipart/form-data`

| Field        | Type   | Required | Description                                                                  |
|--------------|--------|----------|------------------------------------------------------------------------------|
| `file`       | File   | Yes      | An `.html` file, `.md` file, or `.zip` archive containing a static site      |
| `password`   | String | No       | Password to protect the paste (max 200 chars)                                |
| `expiration` | String | No       | Auto-delete after: `1h`, `8h`, `24h`, `1w`, or `1d` (e.g. `24h` = 24 hours) |

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

## Examples

### cURL

```bash
# Upload an HTML file
curl -X POST https://your-host.com/api/upload \
  -H "Authorization: Bearer jolt_YOUR_TOKEN_HERE" \
  -F "file=@./index.html"

# Upload a Markdown file
curl -X POST https://your-host.com/api/upload \
  -H "Authorization: Bearer jolt_YOUR_TOKEN_HERE" \
  -F "file=@./notes.md"

# Upload a ZIP with password and expiration
curl -X POST https://your-host.com/api/upload \
  -H "Authorization: Bearer jolt_YOUR_TOKEN_HERE" \
  -F "file=@./site.zip" \
  -F "password=my-secret" \
  -F "expiration=24h"

# Paste raw HTML
curl -X POST https://your-host.com/api/paste \
  -H "Authorization: Bearer jolt_YOUR_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{"html": "<h1>Hello</h1>", "expiration": "1w"}'

# Paste raw Markdown
curl -X POST https://your-host.com/api/markdown \
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

const uploadRes = await fetch('https://your-host.com/api/upload', {
  method: 'POST',
  headers,
  body: formData,
})
console.log((await uploadRes.json()).url)

// Paste raw Markdown
const mdRes = await fetch('https://your-host.com/api/markdown', {
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
        'https://your-host.com/api/upload',
        headers=headers,
        files={'file': ('notes.md', f, 'text/markdown')},
        data={'expiration': '24h'},
    )
print(response.json()['url'])

# Paste raw Markdown
response = requests.post(
    'https://your-host.com/api/markdown',
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

All three endpoints return the same shape on success (200):

```json
{
  "slug": "quick-dragon-42",
  "url": "https://your-host.com/view/quick-dragon-42",
  "entry_point": "quick-dragon-42/index.md",
  "owner_token": "abc123...",
  "url_with_owner_token": "https://your-host.com/view/quick-dragon-42?owner_token=abc123...",
  "url_with_unlock": "https://your-host.com/view/quick-dragon-42?unlock=TOKEN"
}
```

- **slug** — unique identifier for the paste
- **url** — public URL to view the paste
- **entry_point** — path to the stored file (`index.html`, `index.md`, or the ZIP entry point)
- **owner_token** — use to update password or expiration via `/api/paste/[slug]/password` and `/api/paste/[slug]/expiration`
- **url_with_owner_token** — full URL with owner token in query string
- **url_with_unlock** — *(only when password set)* shareable URL with a signed token that auto-unlocks the page; expires when the paste expires (or in 30 days if no expiration)

## Error Responses

| Status | Meaning |
|--------|---------|
| 400 | Missing or empty content, unsupported file format, invalid expiration, or password too long |
| 401 | No valid web session or API token |
| 413 | Content exceeds size limit |
| 429 | Rate limit exceeded (check `Retry-After` header) |

## API Tokens

API tokens are created in the admin dashboard at `/admin`. To use a token, send it in the `Authorization` header:

```
Authorization: Bearer jolt_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

See the examples above for cURL, JavaScript, and Python usage.
