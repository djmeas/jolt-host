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
    include: ['test/integration/**/*.test.ts'],
    setupTimeout: 120000,
    testTimeout: 15000,
    globalSetup: ['test/setup-integration.mjs'],
    pool: 'forks',
    singleFork: true,
  },
})
