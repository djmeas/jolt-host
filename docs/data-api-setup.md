# Deployment: Jolt Host behind Nginx Proxy Manager + Cloudflare

As-built notes, runbook and pitfalls from a real deployment (verified 2026-09-30). Identifiers are
placeholders — replace them with your own values. Invariants that do **not** depend on your setup are
called out as such.

This guide assumes two domains and the second one's **apex** as the hosted-site base:

| Placeholder | Meaning | Example used here |
|---|---|---|
| `<app-origin>` | Dashboard, upload/API, unlock links | `https://host.example.com` |
| `<site-base>` | Published sites + per-site data API | `https://example.net` |
| site hosts | One label under the base | `https://<slug>.example.net` |
| `<VPS_IP>` | Public IPv4 of the Docker host | `203.0.113.10` |

Using the apex as the base is deliberate: site hosts then sit one label below it, so Cloudflare's
free Universal SSL covers them. A subdomain base such as `sites.example.net` pushes them two labels
deep (`<slug>.sites.example.net`), which Universal SSL does **not** cover — you would need Advanced
Certificate Manager + Total TLS or your own cert.

## Topology

| Role | Domain | DNS provider | TLS |
|---|---|---|---|
| App origin (dashboard, upload/API, unlock) | `<app-origin>` | e.g. Namecheap | Let's Encrypt via NPM |
| Hosted site base (published sites + data API) | `<site-base>` | e.g. Cloudflare | Origin cert at origin, edge cert at Cloudflare |

- Docker containers, both attached to an external network (named `proxy-jolt` here):
  - `jolt-host-app-1` — the app. Compose project `jolt-host`, working dir `<compose-dir>`. Listens on
    **container port 3000** (plain HTTP). **No published host port** — NPM reaches it by container
    name over the shared network.
  - the NPM container (`nginxproxymanager-app-1` when NPM's compose project is
    `nginxproxymanager`); admin UI on `:81`.
- Named volumes `jolthost-data` / `jolthost-storage` hold all published sites and records.
- Container names come from the compose project name, which defaults to the directory name. Confirm
  yours instead of assuming:

  ```bash
  APP=jolt-host-app-1                                  # verify: docker ps --filter name=jolt
  NPM=$(docker ps --filter ancestor=jc21/nginx-proxy-manager --format '{{.Names}}' | head -1)
  ```

### Required app env (names only — values live in `.env`, never commit them)

- `JOLT_APP_ORIGIN=https://host.example.com`
- `JOLT_SITE_BASE_ORIGIN=https://example.net`
- `JOLT_TRUST_PROXY=true`
- `JOLT_VIEW_SECRET`, `JOLT_DATA_SESSION_SECRET`
- `NUXT_JOLTHOST_ADMIN_PASSWORD` — note the `NUXT_` prefix. `JOLT_ADMIN_PASSWORD` alone has no
  effect in the built image and produces `500 Admin password not configured` on the admin login.

Both origins must be HTTPS **and different registrable domains**: the app checks them with a Public
Suffix List, so `host.example.com` + `sites.example.com` is rejected while `host.example.com` +
`example.net` is accepted. In production the data feature additionally requires a
`JOLT_VIEW_SECRET` of at least 16 characters that is not the built-in default.

If the compose file guards the origins (`${JOLT_APP_ORIGIN:?…}`), a missing value aborts the start —
that is the loudest failure mode and the one you want. Without valid origins the app answers `404`
for every non-loopback host, which looks like a proxy fault but is not.

## NPM proxy hosts

| Domain(s) | Scheme | Forward | Cert |
|---|---|---|---|
| `<app-origin>` | `http` | `jolt-host-app-1` : `3000` | Let's Encrypt |
| `<site-base>` and `*.<site-base>` | `http` | `jolt-host-app-1` : `3000` | Custom (Cloudflare Origin CA) |

Advanced tab for both:

```nginx
client_max_body_size 100m;
proxy_read_timeout   120s;
proxy_set_header     X-Forwarded-Host $host;
```

Use the **container name** (`jolt-host-app-1`) and the **container port** (`3000`) as the upstream.
Never a container IP (`172.x.x.x` — a recreate changes it) and never a host port (it can die with a
container or belong to an unrelated service).

NPM passes `Host` and `Origin` through unchanged by default; the hosted origin and the data API's
same-origin write checks depend on that. Do not add rules that rewrite either one.

## Diagnosing 502 on the app origin

**502 means NPM could not get a valid response from the upstream** — a proxy→container problem:
container down, wrong network, wrong port, wrong scheme. Jolt itself answers `404` (unknown host),
`409` (no password), `503` (data/origins unavailable); those point at the app, not the hop.

```bash
APP=jolt-host-app-1
NPM=$(docker ps --filter ancestor=jc21/nginx-proxy-manager --format '{{.Names}}' | head -1)
```

1. Containers exist and are up, on the shared network:

   ```bash
   docker ps -a --filter name=jolt --format '{{.Names}}\t{{.Status}}\t{{.Networks}}'
   docker network inspect proxy-jolt --format '{{range .Containers}}{{.Name}} {{.IPv4Address}}{{"\n"}}{{end}}'
   docker inspect "$NPM" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}'
   ```

   Both the app and NPM must be listed on the shared network.

2. Name resolution **from inside NPM** (its image is Debian + node; `getent` and `node` exist,
   `curl` and `wget` may not):

   ```bash
   docker exec "$NPM" getent hosts "$APP"
   docker exec "$NPM" node -e "require('dns').promises.lookup(process.argv[1]).then(r => console.log(r.address)).catch(e => { console.error('LOOKUP FAILED:', e.code); process.exit(1) })" "$APP"
   ```

3. HTTP from inside NPM. **A request without the right `Host` header returns Jolt's `404`, because
   the header would be the container name** — you must send the app origin to get the real answer:

   ```bash
   docker exec "$NPM" node -e "const http=require('http');http.get({host:'$APP',port:3000,path:'/api/config',headers:{Host:'host.example.com'}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log(r.statusCode,d))}).on('error',e=>{console.error('FETCH FAILED:',e.code||e.message);process.exit(1)})"
   ```

   Expected: `200 {"authEnabled":true,...,"dataFeatureAvailable":true}`.

4. Host-side check against the container IP (works with or without a published port). Only while the
   container is `Up` — a stopped container has no IP:

   ```bash
   APP_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$APP")
   curl -s -m 5 -H 'Host: host.example.com' "http://$APP_IP:3000/api/config"; echo
   ```

   Do **not** look for `netstat`/`ss` in the app container — the slim Node image has neither.

5. NPM logs — the literal reason:

   ```bash
   docker exec "$NPM" tail -20 /data/logs/proxy-host-<id>_error.log
   ```

   | Log line | Cause |
   |---|---|
   | `connect() failed (111: Connection refused)` | wrong forward port, or app not listening there |
   | `could not be resolved (3: Host not found)` | wrong forward hostname, or NPM not on the shared network |
   | `upstream timed out (110: ...)` | app reachable but hung |
   | `SSL_do_handshake() failed` / `wrong version number` | proxy Scheme is `https`, but Jolt serves plain HTTP — set Scheme to `http` |

   Failure codes from the node check: `ECONNREFUSED` = wrong port, `ENOTFOUND` = wrong name/network,
   `ETIMEDOUT` = reachable but not answering.

### The 502 we actually hit

Stale proxy hosts pointed at `<VPS_IP>:2222` — a **host port** published by an *old* app container
that had been gone for weeks. Rules that prevent a repeat:

- Always use the container name and container port as the upstream (see above). The host port was
  reused by an unrelated service, so the failure looked like a wrong port rather than a dead
  container.
- `docker compose up -d` recreates the container and picks up `.env` and network changes;
  `docker compose restart` does not. Never `down -v`.
- Inspect a generated host config with:

  ```bash
  docker exec "$NPM" sh -c 'cat /data/nginx/proxy_host/<id>.conf'
  docker exec "$NPM" sh -c 'nginx -T | grep -n <hostname>'
  ```

## TLS: Let's Encrypt failures look like "Internal Error" in the NPM UI

NPM's UI shows a generic **Internal Error** when certbot fails; the real reason is in
`/data/logs/letsencrypt.log` (the certbot command is echoed in `docker logs "$NPM"`).

- `no valid A records found for <domain>; no valid AAAA records found` → the domain does not resolve
  at all. Fix DNS first, then re-request. This is the usual blocker: the app origin needs an `A`
  record before NPM can validate it.
- Renewal of a cert whose proxy host was deleted (or whose domain no longer resolves) fails the same
  way; delete unused certs and hosts to stop the noise.
- Negative answers (NODATA) are cached by resolvers. If `dig @8.8.8.8` is empty right after adding a
  record, check the authoritative nameservers and `@1.1.1.1` before concluding anything is broken.

### Wildcard certificates (`*.<site-base>`)

HTTP-01 cannot validate wildcards. Two workable options:

1. **Cloudflare Origin Certificate** — simplest when Cloudflare proxies the traffic. Cloudflare →
   SSL/TLS → Origin Server → create a cert for `<site-base>` + `*.<site-base>` (~15-year validity).
   In NPM: SSL Certificates → Add → **Custom**:
   - Certificate Key = the **Private Key** PEM
   - Certificate = the **Origin Certificate** PEM (paste the whole block)
   - Intermediate = blank
   - (Ignore the separate "Origin CA Key" — that is an account API key.)
   Then set Cloudflare's encryption mode to **Full (strict)**, which works because the origin cert is
   valid for that hostname. NPM custom certs do not auto-renew, but origin certs last ~15 years.
2. **Let's Encrypt DNS-01 via NPM** — Add → domains `<site-base> *.<site-base>`, enable the DNS
   challenge, provider Cloudflare, and paste an API token with `Zone:Read` + `DNS:Edit`.

Cloudflare's edge serves browsers its own certificate, and on a full-setup zone that covers the root
domain and first-level subdomains — which is exactly `<site-base>` and `*.<site-base>`. The origin
certificate only secures the Cloudflare→origin leg. Proxied wildcard records are available on all
Cloudflare plans.

Do **not** use Cloudflare's **Flexible** mode with NPM: NPM's Force-SSL redirects `http` → `https`,
while Flexible makes Cloudflare speak `http` to the origin — the result is an infinite redirect loop.

Verify the origin cert NPM actually serves:

```bash
docker exec "$NPM" sh -c 'echo | openssl s_client -connect 127.0.0.1:443 -servername example.net 2>/dev/null | openssl x509 -noout -subject -issuer -ext subjectAltName -dates'
```

## Hosted site base origin (`<site-base>`) — checklist

1. **DNS — in the site base's zone (Cloudflare or any provider):**
   - `A  @   <VPS_IP>` **Proxied** — wildcards do **not** cover the apex, and without this record
     the base host dies with a Cloudflare `530`. (With a subdomain base, the equivalent is an
     explicit record for that subdomain.)
   - `A  *   <VPS_IP>` **Proxied** — this covers every site slug.
   - Delete or repoint leftover explicit records (for example `www`): **an explicit record overrides
     the wildcard.** Leftover registrar parking or URL-forwarding records surface as a parking page
     over HTTP and Cloudflare `522`/`525` over HTTPS.
2. **NPM proxy host:** domains `<site-base> *.<site-base>` → scheme `http` →
   `jolt-host-app-1`:`3000`, custom/origin cert attached, Force SSL on, Advanced snippet above.
3. **Cloudflare:** SSL/TLS mode **Full (strict)**.

### Expected results (these 404s are correct)

- `https://<site-base>/` → **404** — the app intentionally does not serve the dashboard or its APIs
  on the hosted origin (origin isolation).
- `https://<unknown-slug>.<site-base>/` → **404**.
- `https://<published-slug>.<site-base>/` → the site.
- `http://…` → **301** to HTTPS (NPM Force SSL).
- `https://<site-base>/api/config` → **404** (only the app origin exposes config).

### Verification

```bash
dig +short example.net @1.1.1.1                       # Cloudflare anycast IPs when proxied
curl -sS -o /dev/null -w '%{http_code}\n' https://example.net/            # 404
curl -sS -o /dev/null -w '%{http_code}\n' http://example.net/             # 301
curl -sS -o /dev/null -w '%{http_code}\n' https://<slug>.example.net/     # 200 once published
curl -sS https://host.example.com/api/config                              # dataFeatureAvailable:true
```

Local routing test without touching DNS (use the container IP or the Docker host's LAN address):

```bash
curl -s -H 'Host: example.net' "http://<container-ip>:3000/" -o /dev/null -w '%{http_code}\n'
```

## Data API smoke test (after publishing a site)

Per [docs/jolt-data-api.md](jolt-data-api.md): data is per-site, opt-in, requires a site password,
and lives on the hosted origin.

1. On `<app-origin>`: upload a site, set a password, enable data (dashboard toggle, `PUT
   /api/uploads/<slug>/data` with owner proof, or the `enable_data=true` upload field —
   public when `ENABLE_DATA_API_TOGGLE` is not `false`).
2. Served site: `https://<slug>.<site-base>/`.
3. Unauthenticated read:
   `GET https://<slug>.<site-base>/_jolt/data/v1/collections/todos/items` → `401` JSON including
   `login_url`.
4. Sign in for writes at `/_jolt/data/login` (Jolt-owned form; sets a host-only, `HttpOnly`,
   `SameSite=Strict` cookie scoped to `/_jolt/data`), then `POST` the same items URL with
   `Content-Type: application/json`.
5. The slug-level steps are the part most likely to drift with app changes; re-run them after your
   first publish and after any upgrade.

## Ground rules

- Never `docker compose down -v`, `docker volume rm`, or anything else touching the `jolthost-data` /
  `jolthost-storage` volumes — they hold every published site and record.
- Never change `JOLT_VIEW_SECRET`, `JOLT_DATA_SESSION_SECRET` or the admin password to "fix" an
  issue: rotating the view secret invalidates every unlock link; rotating the data secret ends all
  write sessions.
- Do not hand-edit NPM's database, certificates or proxy hosts. Reading is fine: copy
  `/data/database.sqlite` out and query the copy read-only.
- NPM restarts briefly interrupt every proxied site; avoid them unless required.
- Prefer container-name upstreams over container IPs and host ports.
