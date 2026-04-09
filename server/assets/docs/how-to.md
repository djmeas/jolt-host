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
2. Set an **expiration** (how long before the link stops working): 1 hour, 8 hours, 1 day, 3 days, or 1 week.
3. Optionally set a **password** — anyone visiting your link will need to enter it first.
4. Click **Upload**.
5. You'll land on a result page showing your live link. Copy it and share it.

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

## Sharing and access

- Your link is public — anyone who has it can view your site
- If you want to limit access, use the password option
- There is no "private" mode beyond password protection
- Links look like: `https://yourdomain.com/view/abc123`

---

## Rate limits

To prevent abuse, uploads from the same IP address are limited to **25 per hour**. If you hit the limit, wait a while and try again.
