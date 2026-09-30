/**
 * Canonical hosted-site URLs for management pages (dashboard, update, delete,
 * result, My Sites).
 *
 * The hosted origin is a *runtime* setting (`JOLT_SITE_BASE_ORIGIN`), so a page
 * must not trust the value baked into the bundle by `runtimeConfig.public` at
 * build time. The server publishes the live values per request (see
 * `server/middleware/site-origins.global.ts`); they are read here during SSR and
 * serialized through `useState`, so the hydrated client uses exactly the same
 * origin the server did.
 */

export type SiteOrigins = { appOrigin: string; siteBaseOrigin: string }

/** Live server values win; baked public config is only a fallback. */
export function resolveSiteOrigins(
  fromServer: Partial<SiteOrigins> | null | undefined,
  fromPublicConfig: Partial<SiteOrigins> | null | undefined
): SiteOrigins {
  return {
    appOrigin: fromServer?.appOrigin || fromPublicConfig?.appOrigin || '',
    siteBaseOrigin: fromServer?.siteBaseOrigin || fromPublicConfig?.siteBaseOrigin || '',
  }
}

/** `<scheme>://<slug>.<base host>[:port]/`, or null when the base is unusable. */
export function buildSiteUrl(baseOrigin: string, slug: string): string | null {
  if (!baseOrigin) return null
  try {
    const parsed = new URL(baseOrigin)
    return `${parsed.protocol}//${slug}.${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}/`
  } catch {
    return null
  }
}

export function readServerOrigins(event: unknown): Partial<SiteOrigins> | null {
  if (!event || typeof event !== 'object') return null
  const context = (event as { context?: unknown }).context
  if (!context || typeof context !== 'object' || !('siteOrigins' in context)) return null
  const origins = context.siteOrigins
  if (!origins || typeof origins !== 'object') return null
  return origins
}

export function useSiteUrl() {
  const config = useRuntimeConfig()

  // Computed during SSR and shipped in the payload, so hydration reuses the
  // server's value instead of re-deriving it on the client.
  const origins = useState<SiteOrigins>('jolt-site-origins', () =>
    resolveSiteOrigins(readServerOrigins(useRequestEvent()), {
      appOrigin: config.public.jolthost?.appOrigin,
      siteBaseOrigin: config.public.jolthost?.siteBaseOrigin,
    })
  )

  function siteUrlFor(slug: string): string {
    return buildSiteUrl(origins.value.siteBaseOrigin, slug) ?? `/view/${slug}`
  }

  return { siteUrlFor, origins }
}
