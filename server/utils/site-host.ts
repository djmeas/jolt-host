import { createReadStream, readFileSync, realpathSync, statSync } from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import { createError, getQuery, getRequestHeader, getRequestHost, sendRedirect, sendStream, setHeader } from 'h3'
import type { H3Event } from 'h3'
import mime from 'mime-types'
import { getDomain } from 'tldts'
import { findUploadBySlug, getStorageDir } from '~/server/utils/db'
import type { UploadRow } from '~/server/utils/db'
import { isProductionRuntime } from '~/server/utils/runtime-mode'
import {
  isViewAuthorized,
  setViewAuthCookie,
  validateUnlockToken,
} from '~/server/utils/view-auth'
import { renderMarkdownPage } from '~/server/utils/markdown'

/**
 * Origin isolation for uploaded static sites.
 *
 * Uploaded HTML is untrusted executable content. It is therefore served from a
 * different registrable domain (`JOLT_SITE_BASE_ORIGIN`, e.g.
 * `https://sites.example.net`) than the application (`JOLT_APP_ORIGIN`, e.g.
 * `https://host.example.com`). Canonical site URLs are `<slug>` prefixed to the
 * base origin's hostname: `https://<slug>.sites.example.net/`.
 *
 * Every value here is derived from configuration and from the server's own
 * database; redirect targets are never built from an arbitrary incoming Host
 * header.
 */

export type OriginParts = {
  origin: string
  scheme: 'http' | 'https'
  hostname: string
  port: string
}

export type SiteHostConfig = {
  configured: boolean
  reason: string | null
  app: OriginParts | null
  site: OriginParts | null
}

export type SiteHostMatch = { slug: string }

const SLUG_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

function defaultPort(): string {
  return process.env.PORT || process.env.NITRO_PORT || '3000'
}

function parseOrigin(raw: string | undefined): OriginParts | null {
  if (!raw || !raw.trim()) return null
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.pathname !== '/' && url.pathname !== '') return null
  if (url.search || url.hash) return null
  return {
    origin: url.origin,
    scheme: url.protocol === 'https:' ? 'https' : 'http',
    hostname: url.hostname.toLowerCase(),
    port: url.port,
  }
}

/**
 * Loopback hosts cannot be reached from another machine and cannot be delegated
 * by DNS, so they carry no origin-isolation risk: no uploaded site can ever
 * share an origin with them from a remote browser.
 */
function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '::1'
  )
}

function sameRegistrableDomain(a: string, b: string): boolean {
  const da = getDomain(a, { allowIcannDomains: true, allowPrivateDomains: true })
  const db = getDomain(b, { allowIcannDomains: true, allowPrivateDomains: true })
  return Boolean(da && db && da === db)
}

/** Effective config for the site-host boundary; recomputed per call so tests can stub env. */
export function getSiteHostConfig(): SiteHostConfig {
  const prod = isProductionRuntime()
  let app = parseOrigin(process.env.JOLT_APP_ORIGIN)
  let site = parseOrigin(process.env.JOLT_SITE_BASE_ORIGIN)
  const port = defaultPort()

  // Development/test fall back to loopback defaults; production must be configured.
  if (!app && !prod) {
    app = { origin: `http://localhost:${port}`, scheme: 'http', hostname: 'localhost', port }
  }
  if (!site && !prod) {
    site = { origin: `http://sites.localhost:${port}`, scheme: 'http', hostname: 'sites.localhost', port }
  }

  const fail = (reason: string): SiteHostConfig => ({ configured: false, reason, app, site })

  if (!app || !site) {
    return fail('JOLT_APP_ORIGIN and JOLT_SITE_BASE_ORIGIN must both be configured')
  }
  if (!site.hostname.includes('.')) {
    return fail('JOLT_SITE_BASE_ORIGIN must be a base domain such as https://sites.example.net')
  }
  if (app.hostname === site.hostname) {
    return fail('JOLT_APP_ORIGIN and JOLT_SITE_BASE_ORIGIN must use different hostnames')
  }

  if (prod) {
    // Loopback pairs are the development-shaped local deployment (`docker compose
    // up`, `npm run preview`) and are exempt from the public-origin rules.
    const loopback = isLoopbackHostname(app.hostname) && isLoopbackHostname(site.hostname)
    if (!loopback && (app.scheme !== 'https' || site.scheme !== 'https')) {
      return fail(
        'HTTPS is required for JOLT_APP_ORIGIN and JOLT_SITE_BASE_ORIGIN in production (loopback hosts may use http)'
      )
    }
    if (sameRegistrableDomain(app.hostname, site.hostname)) {
      return fail(
        'JOLT_SITE_BASE_ORIGIN must use a different registrable domain than JOLT_APP_ORIGIN'
      )
    }
  }

  return { configured: true, reason: null, app, site }
}

export function isSiteHostConfigured(): boolean {
  return getSiteHostConfig().configured
}

/** Canonical origin for a site: scheme, `<slug>.` hostname, configured port. */
export function siteOriginForSlug(slug: string): string | null {
  const cfg = getSiteHostConfig()
  if (!cfg.configured || !cfg.site) return null
  if (!SLUG_LABEL_RE.test(slug)) return null
  return `${cfg.site.scheme}://${slug}.${cfg.site.hostname}${cfg.site.port ? `:${cfg.site.port}` : ''}`
}

/** Canonical public URL for a site, with the trailing slash. */
export function canonicalSiteUrl(slug: string): string | null {
  const origin = siteOriginForSlug(slug)
  return origin ? `${origin}/` : null
}

/**
 * Target for a legacy `/<slug>` app-origin URL. Only the `unlock` (view-only)
 * token is carried across; owner tokens, passwords, and any other query
 * credentials are dropped rather than forwarded into uploaded JavaScript.
 */
export function legacyViewTarget(
  slug: string,
  pathSuffix: string,
  unlockToken: string | null
): string | null {
  const origin = siteOriginForSlug(slug)
  if (!origin) return null
  const url = new URL(`${origin}/${pathSuffix.replace(/^\/+/, '')}`)
  if (unlockToken) url.searchParams.set('unlock', unlockToken)
  return url.toString()
}

function normalizePort(port: string, scheme: string): string {
  if (!port) return ''
  if (scheme === 'https' && port === '443') return ''
  if (scheme === 'http' && port === '80') return ''
  return port
}

function splitHostPort(host: string | undefined): { hostname: string; port: string } | null {
  if (!host || typeof host !== 'string') return null
  const value = host.trim().toLowerCase()
  if (!value) return null
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    if (end < 0) return null
    const hostname = value.slice(1, end)
    const rest = value.slice(end + 1)
    if (rest && !rest.startsWith(':')) return null
    return { hostname, port: rest.startsWith(':') ? rest.slice(1) : '' }
  }
  const first = value.indexOf(':')
  const last = value.lastIndexOf(':')
  if (first !== -1 && first !== last) return null
  if (last !== -1) return { hostname: value.slice(0, last), port: value.slice(last + 1) }
  return { hostname: value, port: '' }
}

/** The Host header to route on: the socket's Host, or X-Forwarded-Host behind a trusted proxy. */
export function getEffectiveHost(event: H3Event): string | undefined {
  if (process.env.JOLT_TRUST_PROXY === 'true') {
    return getRequestHost(event, { xForwardedHost: true })
  }
  return getRequestHost(event)
}

/**
 * Matches a request Host against the configured hosted-site base. Returns the
 * slug only for `<slug>.<base hostname>` with the exact configured port.
 */
export function matchSiteHost(hostHeader: string | undefined): SiteHostMatch | null {
  const cfg = getSiteHostConfig()
  if (!cfg.configured || !cfg.site) return null
  const parsed = splitHostPort(hostHeader)
  if (!parsed) return null
  const baseHost = cfg.site.hostname
  if (parsed.hostname !== baseHost && !parsed.hostname.endsWith(`.${baseHost}`)) return null
  if (normalizePort(parsed.port, cfg.site.scheme) !== normalizePort(cfg.site.port, cfg.site.scheme)) {
    return null
  }
  if (parsed.hostname === baseHost) return null
  const prefix = parsed.hostname.slice(0, parsed.hostname.length - baseHost.length - 1)
  if (!prefix || !SLUG_LABEL_RE.test(prefix)) return null
  return { slug: prefix }
}

export function isSiteHostRequest(event: H3Event): boolean {
  return matchSiteHost(getEffectiveHost(event)) !== null
}

/**
 * True for any host under the configured site base, whether or not it is a
 * valid `<slug>.<base>`. The application must never be served on the hosted
 * registrable domain, so the dispatcher 404s these instead of falling through.
 */
export function isSiteBaseHost(hostHeader: string | undefined): boolean {
  const cfg = getSiteHostConfig()
  if (!cfg.configured || !cfg.site) return false
  const parsed = splitHostPort(hostHeader)
  if (!parsed) return false
  return (
    parsed.hostname === cfg.site.hostname ||
    parsed.hostname.endsWith(`.${cfg.site.hostname}`)
  )
}

/** True only for the configured application origin (hostname and port). */
export function isAppOriginHost(hostHeader: string | undefined): boolean {
  const cfg = getSiteHostConfig()
  if (!cfg.app) return false
  const parsed = splitHostPort(hostHeader)
  if (!parsed) return false
  return (
    parsed.hostname === cfg.app.hostname &&
    normalizePort(parsed.port, cfg.app.scheme) === normalizePort(cfg.app.port, cfg.app.scheme)
  )
}

/**
 * True for a loopback Host header, with or without an explicit port
 * (`localhost:3000`, `127.0.0.1`, `[::1]:8080`, `sites.localhost`).
 *
 * The production gate uses this so a loopback request can always reach the
 * application: loopback is unreachable from any other machine, and without it a
 * deployment with no configured origins (local `docker compose up` before the
 * origins are set, `npm run preview`) would 404 every page.
 */
export function isLoopbackHost(hostHeader: string | undefined): boolean {
  const parsed = splitHostPort(hostHeader)
  return parsed ? isLoopbackHostname(parsed.hostname) : false
}

/**
 * Resolves the site for a request on a hosted origin. Throws 404 for an unknown
 * host, unknown slug, or expired site so nothing about the app leaks there.
 */
export function requireSiteHostRow(event: H3Event): { slug: string; row: UploadRow; origin: string } {
  const match = matchSiteHost(getEffectiveHost(event))
  if (!match) throw createError({ statusCode: 404, message: 'Not found' })
  const row = findUploadBySlug(match.slug)
  if (!row) throw createError({ statusCode: 404, message: 'Not found' })
  if (row.expires_at && new Date(row.expires_at) <= new Date()) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }
  const origin = siteOriginForSlug(match.slug)
  if (!origin) throw createError({ statusCode: 404, message: 'Not found' })
  return { slug: match.slug, row, origin }
}

/**
 * Requires a state-changing request to come from exactly this site's canonical
 * origin, so a cross-origin form post or credentialed cross-origin request can
 * never be authorized by cookie alone.
 *
 * Browsers send `Origin: null` (or omit it entirely) for same-origin
 * navigational POSTs such as a password form submission. In that case the Fetch
 * metadata `Sec-Fetch-Site` decides: it is set by the browser and cannot be
 * forged by page scripts, so `same-origin` is proof and anything else is not.
 */
export function requireExactOrigin(event: H3Event, expectedOrigin: string): void {
  const origin = getRequestHeader(event, 'origin')
  if (origin && origin !== 'null') {
    if (origin === expectedOrigin) return
    throw createError({ statusCode: 403, message: 'Origin does not match this site' })
  }

  const fetchSite = (getRequestHeader(event, 'sec-fetch-site') ?? '').trim().toLowerCase()
  if (fetchSite === 'same-origin') return

  throw createError({ statusCode: 403, message: 'Origin does not match this site' })
}

/**
 * Application routes that must never be reachable from a hosted site origin.
 * Everything else on a site origin is resolved against that site's own stored
 * files, so the app's page/API/asset routes can never run there.
 */
const APP_PATH_PREFIXES = [
  '/api',
  '/admin',
  '/dashboard',
  '/_nuxt',
  '/__nuxt',
  '/_ipx',
  '/view',
  '/login',
  '/register',
  '/logout',
  '/paste',
  '/markdown',
  '/editor',
  '/previewer',
  '/my-sites',
  '/how-to',
  '/privacy',
  '/terms',
  '/result',
  '/update',
  '/delete',
  '/sitemap.xml',
  '/data',
]

export function isBlockedAppPath(pathname: string): boolean {
  for (const prefix of APP_PATH_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return true
  }
  return false
}

/** The only hosted-origin paths Jolt itself owns. */
export function isJoltHostedPath(pathname: string): boolean {
  return pathname === '/_jolt/unlock' || pathname === '/_jolt/data' || pathname.startsWith('/_jolt/data/')
}

function isInside(baseDir: string, target: string): boolean {
  const rel = relative(baseDir, target)
  if (rel === '') return true
  if (rel === '..' || rel.startsWith(`..${'/'}`) || rel.startsWith(`..${'\\'}`)) return false
  return !isAbsolute(rel)
}

/**
 * Resolves a requested site path to a real file inside the site's own content
 * directory. Uses realpath containment (not string prefixes) so `..` and
 * symlinks pointing outside the site cannot escape.
 */
function resolveExistingFile(baseDir: string, requested: string): string | null {
  if (requested.includes('\0')) return null
  const candidate = requested === '' ? baseDir : resolve(baseDir, requested)
  let realBase: string
  try {
    realBase = realpathSync(baseDir)
  } catch {
    return null
  }
  if (!isInside(resolve(baseDir), candidate) && candidate !== baseDir) return null
  let real: string
  try {
    real = realpathSync(candidate)
  } catch {
    return null
  }
  if (!isInside(realBase, real)) return null
  try {
    if (statSync(real).isDirectory()) {
      const indexPath = join(real, 'index.html')
      const realIndex = realpathSync(indexPath)
      if (!isInside(realBase, realIndex)) return null
      if (!statSync(realIndex).isFile()) return null
      return realIndex
    }
    if (!statSync(real).isFile()) return null
  } catch {
    return null
  }
  return real
}

/**
 * Serves a hosted site's static HTML/assets. Uploaded content is never
 * executed: Markdown is rendered to HTML by Jolt, everything else is streamed
 * with its file type.
 */
export async function serveSiteContent(event: H3Event, row: UploadRow, pathname: string) {
  if (row.password_hash && !isViewAuthorized(event, row.slug)) {
    const unlock = event.method === 'GET' ? getQuery(event).unlock : undefined
    if (typeof unlock === 'string' && unlock && validateUnlockToken(row.slug, unlock)) {
      // An unlock link grants view access only. It never mints a data session,
      // and the URL keeps its token so it can still be bookmarked and shared.
      setViewAuthCookie(event, row.slug)
    } else {
      return sendRedirect(event, '/_jolt/unlock', 302)
    }
  }

  const baseDir = dirname(join(getStorageDir(), row.entry_point))
  const requested = pathname.replace(/^\/+/, '')
  const filePath = requested === ''
    ? resolveExistingFile(baseDir, basename(row.entry_point))
    : resolveExistingFile(baseDir, requested)

  if (!filePath) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  if (filePath.toLowerCase().endsWith('.md')) {
    const source = readFileSync(filePath, 'utf8')
    setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
    setHeader(event, 'Cache-Control', 'no-store')
    return renderMarkdownPage(source)
  }

  const mimeType = mime.lookup(filePath) || 'text/html'
  setHeader(event, 'Content-Type', mimeType)
  setHeader(event, 'Cache-Control', requested === '' ? 'no-store' : 'no-cache')
  return sendStream(event, createReadStream(filePath))
}
