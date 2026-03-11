# How to Use the Upload Endpoint

Upload static HTML files or ZIP archives to host them and get a shareable link.

## Endpoint

```
POST /api/upload
```

**Content-Type:** `multipart/form-data`

## Authentication

**Anonymous uploads via the API are disabled.** You must use one of:

1. **Web form** – Visit `/` in a browser to upload. A session cookie is set automatically.
2. **API token** – Include the token in the `Authorization` header for programmatic uploads:

```
Authorization: Bearer jolt_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Tokens are created in the admin dashboard at `/admin`.

## Form Fields

| Field       | Type   | Required | Description                                                                 |
|-------------|--------|----------|-----------------------------------------------------------------------------|
| `file`      | File   | Yes      | An `.html` file or `.zip` archive containing a static site                   |
| `password`  | String | No       | Password to protect the site (max 200 chars)                                |
| `expiration`| String | No       | Auto-delete after: `1h`, `8h`, `24h`, `1w`, or `1d` (e.g. `24h` = 24 hours) |

## Limits

- **File size:** 25MB (configurable via `NUXT_JOLTHOST_UPLOAD_MAX_BYTES`)
- **Rate limit:** 25 uploads per IP per hour
- **Accepted formats:** `.html` or `.zip` only
- **ZIP requirement:** Must contain at least one `.html` file; `index.html` is used as entry point if present

## Response

Success (200):

```json
{
  "slug": "quick-dragon-42",
  "url": "https://your-host.com/view/quick-dragon-42",
  "entry_point": "quick-dragon-42/index.html",
  "owner_token": "abc123...",
  "url_with_owner_token": "https://your-host.com/view/quick-dragon-42?owner_token=abc123...",
  "url_with_unlock": "https://your-host.com/view/quick-dragon-42?unlock=TOKEN"
}
```

- **slug** – Unique identifier for the site
- **url** – Public URL to view the site
- **entry_point** – Path to the main HTML file
- **owner_token** – Use to update password or expiration via `/api/paste/[slug]/password` and `/api/paste/[slug]/expiration`
- **url_with_owner_token** – Full URL with owner token in query; convenient for bookmarking or passing to management APIs
- **url_with_unlock** – (when password provided) Shareable URL with a signed token; visiting it unlocks the page automatically. Token expires when the paste expires (or in 30 days if no expiration). The password is never shown in the URL.

## Examples

### cURL

```bash
# Basic upload
curl -X POST https://your-host.com/api/upload \
  -F "file=@./index.html"

# With password and expiration
curl -X POST https://your-host.com/api/upload \
  -F "file=@./site.zip" \
  -F "password=my-secret" \
  -F "expiration=24h"

# With API token (add Authorization header)
curl -X POST https://your-host.com/api/upload \
  -H "Authorization: Bearer jolt_YOUR_TOKEN_HERE" \
  -F "file=@./index.html"
```

### JavaScript (fetch)

```javascript
const formData = new FormData()
formData.append('file', fileInput.files[0])
formData.append('password', 'optional-password')
formData.append('expiration', '1w')

const headers = {}
if (apiToken) {
  headers['Authorization'] = `Bearer ${apiToken}`
}

const response = await fetch('https://your-host.com/api/upload', {
  method: 'POST',
  headers,
  body: formData,
})
const result = await response.json()
console.log(result.url)
```

### Python (requests)

```python
import requests

api_token = 'jolt_YOUR_TOKEN_HERE'  # or None for anonymous upload
headers = {}
if api_token:
    headers['Authorization'] = f'Bearer {api_token}'

with open('index.html', 'rb') as f:
    response = requests.post(
        'https://your-host.com/api/upload',
        headers=headers,
        files={'file': ('index.html', f, 'text/html')},
        data={'password': 'optional', 'expiration': '24h'},
    )
result = response.json()
print(result['url'])
```

### Postman

Import the collection from `docs/postman-upload-collection.json`:

1. Open Postman → **Import** → select the JSON file
2. Set collection variables: **baseUrl** (e.g. `http://localhost:3000`), **apiToken** (your token from `/admin`)
3. In the Body tab, choose **form-data**, add a `file` key, change type to **File**, and select your `.html` or `.zip`
4. Optionally add `password` and `expiration` as text fields

## Error Responses

| Status | Meaning |
|--------|---------|
| 400 | Missing file, invalid format, invalid expiration, or password too long |
| 413 | File exceeds size limit |
| 429 | Rate limit exceeded (check `Retry-After` header) |

## API Tokens

API tokens are created in the admin dashboard at `/admin`. To use a token, send it in the `Authorization` header:

```
Authorization: Bearer jolt_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

See the examples above for cURL, JavaScript, and Python usage.
