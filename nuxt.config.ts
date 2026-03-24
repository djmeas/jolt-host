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
    public: {
      jolthost: {
        /** Max upload size in bytes (exposed to client for validation). Use NUXT_PUBLIC_JOLTHOST_UPLOAD_MAX_BYTES to override. */
        uploadMaxBytes: DEFAULT_UPLOAD_MAX_BYTES,
      },
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
