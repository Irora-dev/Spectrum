import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = dirname(fileURLToPath(import.meta.url))

// Standalone test config (vitest would otherwise load vite.config.ts and spin
// up the crx/tailwind plugins just to run unit tests).
export default defineConfig({
  resolve: {
    alias: { '@app': resolve(here, '../app/src') },
  },
  test: {
    environment: 'node',
  },
})
