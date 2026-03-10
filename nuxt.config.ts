const DEFAULT_UPLOAD_MAX_BYTES = 100 * 1024 * 1024 // 100MB

export default defineNuxtConfig({
  compatibilityDate: '2025-02-18',
  devtools: { enabled: true },
  runtimeConfig: {
    jolthost: {
      /** Max upload size in bytes. Override with NUXT_JOLTHOST_UPLOAD_MAX_BYTES (e.g. 26214400 for 25MB). */
      uploadMaxBytes: DEFAULT_UPLOAD_MAX_BYTES,
      /** Admin password. Set JOLT_ADMIN_PASSWORD in production. */
      adminPassword: '',
    },
  },
  nitro: {
    output: { dir: '.output' },
    experimental: { tasks: true },
    scheduledTasks: {
      // Run cleanup every 15 minutes
      '*/15 * * * *': ['cleanup-expired'],
    },
  },
})
