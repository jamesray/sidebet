import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const src = (p: string): string => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@sidebet/core/testing': src('./packages/core/src/testing/index.ts'),
      '@sidebet/core': src('./packages/core/src/index.ts'),
      '@sidebet/storage-local': src('./packages/storage-local/src/index.ts'),
      '@sidebet/runtime-pi': src('./packages/runtime-pi/src/index.ts'),
    },
  },
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'apps/*/test/**/*.test.ts',
      'extensions/*/test/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    exclude: process.env.SIDEBET_INTEGRATION ? [] : ['tests/integration/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
})
