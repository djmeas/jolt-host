import type { SiteOrigins } from '../composables/useSiteUrl'
import { readServerOrigins, resolveSiteOrigins } from '../composables/useSiteUrl'

/**
 * Seeds the hosted-origin state for *every* server-rendered page, not only the
 * pages that build site URLs.
 *
 * Without this, a client-side navigation from a page that never read the state
 * (for example `/paste`) would initialize it in the browser, where there is no
 * request context, and fall back to the origins baked into the bundle at build
 * time — producing links on a stale host.
 */
export default defineNuxtPlugin(() => {
  const config = useRuntimeConfig()
  const origins = useState<SiteOrigins>('jolt-site-origins')
  if (origins.value) return
  origins.value = resolveSiteOrigins(readServerOrigins(useRequestEvent()), {
    appOrigin: config.public.jolthost?.appOrigin,
    siteBaseOrigin: config.public.jolthost?.siteBaseOrigin,
  })
})
