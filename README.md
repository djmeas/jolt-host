# JoltHost — Static Site Pastebin

A minimal pastebin for static sites: upload an HTML file or a ZIP and get a shareable URL. Built with **Nuxt 3**, **SQLite** (better-sqlite3), and **Node fs**.

## Requirements

- **Node.js** ≥ 18 (recommended ≥ 20 for Nuxt 3)

## Setup

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Features

- **Upload** (`.html` or `.zip`) via drag-and-drop or file picker
- **Short slugs** (e.g. `quick-apple-42`) for URLs like `yoursite.com/view/quick-apple-42`
- **Static serving**: `/view/[slug]` serves the entry `index.html`; `/view/[slug]/**` serves assets (CSS, JS, images) with correct `Content-Type`

## API

- **POST `/api/upload`** — `multipart/form-data` with a `file` field (`.html` or `.zip`). Returns `{ slug, url, entry_point }`. Upload size is limited (default 25MB). Set **`NUXT_JOLTHOST_UPLOAD_MAX_BYTES`** (bytes) to change the limit, e.g. `26214400` for 25MB or `52428800` for 50MB.

## Data

- **Database**: `./data/jolt.db` (SQLite, table `uploads`: `id`, `slug`, `entry_point`, `created_at`)
- **Files**: `./storage/[slug]/` — one folder per paste

## Docker / VPS deployment

Build and run with Docker (data and uploads persist in named volumes):

```bash
docker compose up -d --build
```

App is at [http://localhost:3000](http://localhost:3000). On a VPS, use a reverse proxy (e.g. Caddy or Nginx) in front and optionally set `NITRO_PORT=80` or map `80:3000`.

## Scripts

- `npm run dev` — dev server
- `npm run build` — production build
- `npm run preview` — preview production build
