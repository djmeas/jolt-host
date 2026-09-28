# How to use Jolt Host

Jolt Host lets you publish a static site in seconds — no account required. Upload a file, get a link, share it.

---

## What you can upload

| Format | What it does |
|---|---|
| `.html` | A single HTML file, served as-is |
| `.md` | A Markdown file, rendered as a styled HTML page with a theme switcher |
| `.zip` | A full static site — your ZIP must contain an `index.html` at the root |

**File size limits:** HTML and Markdown files up to 25 MB. ZIP archives up to 5 MB.

---

## Uploading a file

1. On the home page, drag your file into the upload area — or click it to open a file picker.
2. Optionally enter a **title** — a personal label for your own reference (e.g. "Client demo v2"). It appears in your My Sites history and is appended to the share URL as a `?title=` parameter.
3. Set an **expiration** (how long before the link stops working): 1 hour, 8 hours, 1 day, 3 days, or 1 week.
4. Optionally set a **password** — anyone visiting your link will need to enter it first.
5. Click **Upload**.
6. You'll land on a result page showing your live link. Copy it and share it.

---

## Other ways to publish

If you don't have a file ready, you can write or paste content directly:

### Paste HTML
Go to **Paste HTML** on the home page. Type or paste raw HTML into the editor and submit. Works the same as uploading a `.html` file.

### Edit HTML
Go to **Edit HTML** for a live split-pane editor — write HTML on the left, see a preview on the right. Submit when you're happy with it.

### Paste Markdown
Go to **Paste Markdown** to write or paste Markdown. Jolt Host converts it to a styled, self-contained HTML page with a built-in theme switcher (GitHub, Dracula, Solarized, Nord).

---

## Expiration

Every upload has an expiration time you choose before submitting. Once the time passes, the link stops working and the files are cleaned up automatically. If you need the content to stay up longer, upload again and choose a longer expiration.

---

## Password protection

Setting a password means anyone who visits your link will be shown a prompt before they can see the page. The password is hashed before being stored — it cannot be recovered if you forget it. If you lose the password to a protected upload, you can still delete it using the delete link (see below).

---

## Deleting your upload

After a successful upload, the result page shows a **Delete this site** link at the bottom. This link is only visible on that page, immediately after uploading — it contains a secret token tied to your upload.

**If you think you may need to delete your upload later, save that link before navigating away.**

Clicking the delete link takes you to a confirmation page. Confirm, and the site and all its files are permanently removed.

If you navigate away without saving the link, the upload will remain until it expires naturally. Administrators can also remove uploads on request.

---

## ZIP archives

To publish a multi-page or asset-heavy site, bundle it as a ZIP:

- The ZIP **must contain `index.html` at the root** (not inside a subfolder)
- Other HTML files, images, CSS, and JavaScript can be placed in subfolders
- Maximum ZIP size is 5 MB

Example structure:
```
my-site.zip
├── index.html
├── about.html
├── style.css
└── images/
    └── logo.png
```

---

## My Sites

After each successful upload, the site is saved to your **My Sites** history, accessible via the link in the top-left of the navbar (it only appears once you have at least one saved site).

My Sites shows each entry's title (if you set one), the live link, its publish date, and its expiration date.

**Important:** My Sites data is stored entirely in your browser's `localStorage`. It never leaves your device and is not linked to your account or IP address. This means:

- It is only visible in the browser you used to publish
- It will be lost if you clear your browser data or use a private/incognito window
- It is not synced across devices or browsers

You can delete all My Sites history at any time by clicking the **Clear My Sites data** button at the bottom of the My Sites page.

---

## Sharing and access

- Your link is public — anyone who has it can view your site
- If you want to limit access, use the password option
- There is no "private" mode beyond password protection
- Links look like: `https://yourdomain.com/view/abc123`

---

## Publishing from the API

You can publish and update sites from scripts, CI pipelines, or any tool that can make HTTP requests. The API uses the same formats and limits as the web form (`.html`, `.md`, or `.zip`).

### Getting an API token

API tokens are created in the admin dashboard at **`/admin`**. Create a token, copy it once, and keep it secret. Send it on every request:

```
Authorization: Bearer jolt_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

> The API does not accept anonymous uploads. You need an API token, or a logged-in browser session. An API token works on its own — including when the host runs in **registered-users-only** mode — so scripts and CI can publish without a login.

### Uploading a new site

Send a `multipart/form-data` request to `POST /api/upload` with a `file` field. Add `password`, `expiration` (`1h`, `8h`, `24h`, `1w`, or `1d`), and `title` as optional fields.

```bash
curl -X POST https://yourdomain.com/api/upload \
  -H "Authorization: Bearer jolt_YOUR_TOKEN" \
  -F "file=@./index.html" \
  -F "expiration=24h" \
  -F "title=My Site"
```

The response includes the shareable URL and the **owner token**:

```json
{
  "slug": "quick-dragon-7f3a9c",
  "url": "https://yourdomain.com/view/quick-dragon-7f3a9c",
  "entry_point": "quick-dragon-7f3a9c/index.html",
  "owner_token": "abc123...",
  "url_with_owner_token": "https://yourdomain.com/view/quick-dragon-7f3a9c?owner_token=abc123...",
  "url_with_unlock": "https://yourdomain.com/view/quick-dragon-7f3a9c?unlock=TOKEN"
}
```

Slugs are generated as `adjective-noun-hash` (for example `mystic-ninja-b589aa`). The trailing hash is random, so use the exact `slug` from the response rather than constructing one yourself.

**Keep the `owner_token`** — it is shown only once and is what lets you update or delete the site later without a logged-in account. Save it somewhere safe.

```javascript
const form = new FormData()
form.append('file', fileInput.files[0])
form.append('expiration', '24h')

const res = await fetch('https://yourdomain.com/api/upload', {
  method: 'POST',
  headers: { Authorization: 'Bearer jolt_YOUR_TOKEN' },
  body: form,
})
const data = await res.json()
console.log(data.url)          // shareable link
console.log(data.owner_token)  // save this to update or delete later
```

### Replacing an existing site's files

To publish a new version **at the same URL**, send the full new file set (as a ZIP for multiple files) to `PUT /api/uploads/[slug]/content`. The replacement replaces the *entire* site: any file you leave out stops being served. The URL, title, password, owner token, and expiration all stay the same, and updating does **not** reset the expiration timer.

Provide the site's `owner_token` as a form field (never in the URL). With a valid API token, the `owner_token` is what proves you own the site — so an API token plus the owner token is enough to replace a site, even in **registered-users-only** mode, without logging in. If you are logged in as the owner, or are an admin, you do not need the owner token.

```bash
# Replace all files for the site at /view/quick-dragon-7f3a9c
curl -X PUT https://yourdomain.com/api/uploads/quick-dragon-7f3a9c/content \
  -H "Authorization: Bearer jolt_YOUR_TOKEN" \
  -F "file=@./site-v2.zip" \
  -F "owner_token=abc123..."
```

```javascript
const form = new FormData()
form.append('file', fileInput.files[0])
form.append('owner_token', 'abc123...') // omit when logged in as the owner

const res = await fetch('https://yourdomain.com/api/uploads/quick-dragon-7f3a9c/content', {
  method: 'PUT',
  headers: { Authorization: 'Bearer jolt_YOUR_TOKEN' },
  body: form,
})
const { slug, url, entry_point } = await res.json()
```

On success you get back the unchanged `slug` and `url` plus the new `entry_point`:

```json
{
  "slug": "quick-dragon-7f3a9c",
  "url": "https://yourdomain.com/view/quick-dragon-7f3a9c",
  "entry_point": ".content/quick-dragon-7f3a9c/8f2c.../index.html"
}
```

Notes:

- A ZIP replacement removes the previous files, including the old `index.html` or `index.md`.
- If the upload is invalid or fails, your existing site keeps working.
- Requesting a replacement for an expired or deleted site returns an error; it cannot revive a site.
- The same rate limit applies (25 per hour per IP).

### Managing an existing site

Use the owner token to change settings without re-uploading files:

| Action | Endpoint | Body |
|---|---|---|
| Set or change password | `POST /api/paste/[slug]/password` | `{ "owner_token": "...", "password": "..." }` |
| Set or clear expiration | `POST /api/paste/[slug]/expiration` | `{ "owner_token": "...", "expiration": "24h" }` |

### API errors

| Status | Meaning |
|---|---|
| 400 | Missing or invalid file, unsupported format, or failed CAPTCHA |
| 401 | Not authenticated — no valid API token and no login |
| 403 | Authenticated (login or API token) but not proven as the site's owner |
| 404 | Site not found or expired |
| 409 | A concurrent update changed the site first |
| 413 | File (or expanded ZIP) is too large |
| 429 | Rate limit exceeded (check the `Retry-After` header) |

For full details and more examples (Python, Postman), see the [upload endpoint reference](https://github.com/djmeas/jolt-host/blob/main/docs/how-to-use-upload-endpoint.md).

---

## Rate limits

To prevent abuse, uploads from the same IP address are limited to **25 per hour**. If you hit the limit, wait a while and try again.
