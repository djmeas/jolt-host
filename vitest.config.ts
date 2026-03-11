import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '~': path.resolve(__dirname),
    },
  },
  test: {
    environment: 'node',
    include: ['server/**/*.test.ts', 'test/integration/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'test/nuxt/**'],
    setupTimeout: 120000,
    testTimeout: 15000,
  },
})
