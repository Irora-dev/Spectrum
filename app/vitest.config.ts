import { defineConfig } from 'vitest/config'

// Standalone config (does NOT pull in the app's vite plugins): the only tests are
// pure leaf modules (e.g. the Tier-1 swap-quote floor math), so a plain node env is
// enough. `npm test` → vitest run.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
