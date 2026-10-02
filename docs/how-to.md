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

## AI Builder (optional)

If the operator has configured it, the home page shows an **Upload | Build** tab strip on the upload box. The **Build** tab lets you describe a static site in plain text and have a configured model write the files for a private, account-only workspace:

1. Sign in (the builder always needs a registered account, even where anonymous uploads are allowed).
2. Describe the site, e.g. "a one-page portfolio with a dark theme and a contact section", and send.
3. Read the reply summary and open any generated text file to inspect it. Follow-up messages patch the same workspace.
4. Click **Preview** to publish the current files as a real, brand-new site you own. Each Preview creates a separate upload with its own link; the workspace stays private and is not attached to it. Continue iterating and Preview again whenever you like.

The result page and dashboard work exactly like an ordinary upload.

### Edit an existing upload

If a site in your dashboard is eligible (owned, not anonymous, not expired), its row menu shows **Edit with AI**. That opens the Build tab with the site preselected; confirm **Attach** to load its live files into your workspace. Attaching replaces your current draft and chat session, so save anything you still need first.

1. **Attach** copies the site's served files into the workspace. Text files (`.html`, `.css`, `.js`, `.md`, `.txt`, `.svg`, `.json`) become editable; images and other binary files are kept as read-only **opaque assets**. Opaque bytes are never sent to the model and cannot be changed or deleted by it, but they are carried through every turn and republished with the site.
2. Describe your change and send. Patches update only editable text.
3. Click **Publish changes** to replace the site's files through the ordinary replacement pipeline. The site keeps the **same URL, slug, password, expiration, and Data API settings**, and no new dashboard entry is created. Publishing sends only your editable text plus the retained assets; the model never sees the binaries.
4. **Restore previous version** brings back the site's bytes from the moment you attached it — into your local draft only. Nothing changes on the live site until you publish again. If someone replaced the site elsewhere after you attached it, publishing returns a conflict (`409`) and you must attach again rather than overwrite their change.
5. **Start a new site** discards the attachment and returns to new-site mode (your previous messages stay in the account's cost history, but are excluded from the new session).

Attaching is refused when the site's editable text exceeds the workspace caps (50 files, 1 MiB per file, 5 MiB total). Only the site's owner, or a registered account with an admin session, can attach it; anonymous owner-token sites are excluded.

**Operator notes**

- **Enable it** by setting `JOLT_AI_API_KEY`, `JOLT_AI_BASE_URL` (an absolute HTTPS OpenAI-compatible base ending in `/v1`, e.g. your gateway URL), and `JOLT_AI_MODEL`. `ENABLE_AI_BUILDER=false` kills the feature. With any value missing the feature fails closed: the Build tab and dashboard link stay hidden and `/api/ai/**` returns `503`. The gateway must accept the fixed request shape (`stream: false`, `n: 1`, `max_tokens: 32768`, one `finish_reason: "stop"` completion); Jolt never falls back to another model.
- **Local development origins** — in development and test only, direct requests from `http://localhost`, `http://127.0.0.1`, or `http://[::1]` are accepted on any port. This accommodates Nuxt choosing a fallback port such as `3001`. Hosted `<slug>.sites.localhost` origins remain blocked; production requires the exact configured `JOLT_APP_ORIGIN`.
- **What leaves the server** — the user's message and the current editable file contents are sent to that endpoint for each turn. The key stays server-side and never appears in responses, logs, prompts, or transcripts. Generated sites are still untrusted content served only from the isolated hosted origin.
- **Storage** — one workspace per account at `./storage/.workspaces/<user-id>/`, private and never served. It persists across logins and restarts; upload/TTL cleanup never removes it. Deleting the account removes its AI rows and workspace. Back up the SQLite `ai_workspaces`/`ai_messages` tables together with that directory to keep transcripts and generated files consistent.
- **Caps and cost** — at most 50 editable files, 1 MiB per file, and 5 MiB of generated text per workspace (private generation/metadata storage is separate, so the disk footprint can be larger). Each model call stores its model, provider-reported token counts, and duration in `ai_messages`; unknown usage is `null`. There is **no usage dashboard** — read the raw rows from the database. Chat is limited to 30 accepted attempts per account per hour and one in-flight operation at a time.
- **Not an agent** — one message is one model call that must return a validated file manifest. No shell, containers, package installs, builds, tools, streaming, retries, or server-side execution of generated code.

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

The normal site link is a public address, not an invitation or an account permission. Without a
password, anyone who opens it can view the page and its assets without signing in. The random slug
makes a link harder to guess, but anyone you send it to can forward it. There is no invite-only or
per-visitor private mode; use a site password if you need to limit viewing.

### Passwords and unlock links

With a password, visitors enter it on a Jolt-owned form before the site is shown. Share the normal
site URL and the password separately. A browser that has already unlocked the site can keep viewing
it for up to 30 days: changing the password blocks new attempts with the old password, but **does
not revoke existing view access**. Deleting the site or letting it expire ends access to it.

If your result includes a `?unlock=...` URL, treat it like a key: anyone holding that link can bypass
the password prompt and view the site until the link expires. It can be forwarded just like the
normal link; changing the password does not invalidate it. An unlock link **does not** allow edits
to site data or changes to the upload. Keep the **Delete this site** link and `owner_token` private:
they authorize site management, not just viewing.

### Why the site has its own host

A link looks like `https://quick-dragon-7f3a9c.sites.example.net/`. The slug identifies the site;
`sites.example.net` represents the hosted-site domain configured by the operator, separate from
the Jolt Host app domain. Uploaded HTML and JavaScript run on that site's host, not alongside your
app login or dashboard. This isolates app credentials; it does **not** make an unprotected site
private or stop someone with access from sharing its content.

Older app-domain `/view/<slug>` links redirect to the same hosted site, including asset paths.
Only a view-only `?unlock=` token survives the redirect. Passwords, owner tokens, and other query
parameters are dropped; use the password form rather than putting a password in a URL.

### If site data is enabled

The owner can opt a **password-protected** site into shared data. Visitors with view access,
including an unlock link, can read its records. Only someone who enters the site password on
Jolt's form can add, change, or delete records. Every password holder edits the **same** records;
there are no private records or separate permissions for individual visitors. A script running in
the site can also make data requests as a signed-in password holder, so publish only scripts you
trust. Disabling data or clearing the password blocks data access but preserves records for later
re-enabling; deleting or expiring the site removes them. API paths, limits, and a working to-do
example are in `docs/jolt-data-api.md` in the repository.

---

## Publishing from the API

You can publish and update sites from scripts, CI pipelines, or any tool that can make HTTP requests. The API uses the same formats and limits as the web form (`.html`, `.md`, or `.zip`).

### Getting an API token

Create a token, copy it once, and keep it secret. Send it on every request:

```
Authorization: Bearer jolt_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Where to create one:

- **Registered users:** **Dashboard → Account Settings → API tokens**. The token belongs to your account.
- **Admins:** the **API Tokens** tab at `/admin`, where you can assign the token to a specific registered user (or leave it unowned).

**Token ownership.** Sites published with a token are attributed to the token's owner, so they show up in that user's **My Uploads**. A token with no owner still works, but its uploads stay unattributed and appear only in the admin dashboard.

> The API does not accept anonymous uploads. You need an API token, or a logged-in browser session. An API token works on its own — including when the host runs in **registered-users-only** mode — so scripts and CI can publish without a login.

### Uploading a new site

Send a `multipart/form-data` request to `POST /api/upload` with a `file` field. Add `password`, `expiration` (`1h`, `8h`, `24h`, `1w`, or `1d`), and `title` as optional fields.

```bash
curl -X POST https://host.example.com/api/upload \
  -H "Authorization: Bearer jolt_YOUR_TOKEN" \
  -F "file=@./index.html" \
  -F "expiration=24h" \
  -F "title=My Site"
```

The response includes the shareable URL and the **owner token**:

```json
{
  "slug": "quick-dragon-7f3a9c",
  "url": "https://quick-dragon-7f3a9c.sites.example.net/",
  "entry_point": "quick-dragon-7f3a9c/index.html",
  "owner_token": "abc123...",
  "url_with_unlock": "https://quick-dragon-7f3a9c.sites.example.net/?unlock=TOKEN"
}
```

`url` is the canonical public URL on the hosted-site origin; `url_with_unlock` is only present when you set a password. The owner token is returned only in this one-time JSON response — it is never part of a URL.

Slugs are generated as `adjective-noun-hash` (for example `mystic-ninja-b589aa`). The trailing hash is random, so use the exact `slug` from the response rather than constructing one yourself.

**Keep the `owner_token`** — it is shown only once and is what lets you update or delete the site later without a logged-in account. Save it somewhere safe.

If the token that made the request belongs to a registered user, the new site is added to that user's **My Uploads**. An unowned token's uploads are not attributed to any account.

```javascript
const form = new FormData()
form.append('file', fileInput.files[0])
form.append('expiration', '24h')

const res = await fetch('https://host.example.com/api/upload', {
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
# Replace all files for the site quick-dragon-7f3a9c
curl -X PUT https://host.example.com/api/uploads/quick-dragon-7f3a9c/content \
  -H "Authorization: Bearer jolt_YOUR_TOKEN" \
  -F "file=@./site-v2.zip" \
  -F "owner_token=abc123..."
```

```javascript
const form = new FormData()
form.append('file', fileInput.files[0])
form.append('owner_token', 'abc123...') // omit when logged in as the owner

const res = await fetch('https://host.example.com/api/uploads/quick-dragon-7f3a9c/content', {
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
  "url": "https://quick-dragon-7f3a9c.sites.example.net/",
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
