const DEFAULT_UPLOAD_MAX_BYTES = 100 * 1024 * 1024 // 100MB

// Nitro options are supported at runtime but omitted from NuxtConfig in @nuxt/schema (nitro?: never)
export default defineNuxtConfig({
  compatibilityDate: '2025-02-18',
  devtools: { enabled: true },
  modules: ['notivue/nuxt'],
  css: ['notivue/notification.css', 'notivue/animations.css'],
  runtimeConfig: {
    jolthost: {
      /** Max upload size in bytes. Override with NUXT_JOLTHOST_UPLOAD_MAX_BYTES (e.g. 26214400 for 25MB). */
      uploadMaxBytes: DEFAULT_UPLOAD_MAX_BYTES,
      /** Admin password. Set JOLT_ADMIN_PASSWORD in production. */
      adminPassword: '',
    },
    /** Cloudflare Turnstile secret key. Set NUXT_TURNSTILE_SECRET_KEY in production. */
    turnstileSecretKey: '',
    public: {
      jolthost: {
        /** Max upload size in bytes (exposed to client for validation). Use NUXT_PUBLIC_JOLTHOST_UPLOAD_MAX_BYTES to override. */
        uploadMaxBytes: DEFAULT_UPLOAD_MAX_BYTES,
      },
      /** Cloudflare Turnstile site key (public). Set NUXT_PUBLIC_TURNSTILE_SITE_KEY in production. */
      turnstileSiteKey: '',
      /** Show Buy Me a Coffee badge. Set SHOW_BUYMEACOFFEE_LINK=true to enable. */
      showBuyMeACoffee: process.env.SHOW_BUYMEACOFFEE_LINK === 'true',
      /** Cloudflare Web Analytics token. Set CF_BEACON_TOKEN in production. */
      cfBeaconToken: process.env.CF_BEACON_TOKEN ?? '',
    },
  },
  app: {
    head: {
      title: 'Jolt Host',
      link: [
        {
          rel: 'icon',
          type: 'image/svg+xml',
          href: 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>⚡</text></svg>',
        },
      ],
      script: [
        ...(process.env.CF_BEACON_TOKEN
          ? [
              {
                src: 'https://static.cloudflareinsights.com/beacon.min.js',
                defer: true,
                'data-cf-beacon': `{"token": "${process.env.CF_BEACON_TOKEN}"}`,
              },
            ]
          : []),
      ],
    },
  },
  // @ts-expect-error - nitro is valid at runtime; schema types omit it (Nuxt 4 compat)
  nitro: {
    output: { dir: '.output' },
    experimental: { tasks: true },
    scheduledTasks: {
      // Run cleanup every 15 minutes
      '*/15 * * * *': ['cleanup-expired'],
    },
  },
})
