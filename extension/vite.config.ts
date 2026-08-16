import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.config'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react(), tailwindcss(), crx({ manifest })],
  resolve: {
    // The shared analytical core. CONSUMED, never modified — app/src/lib is
    // owned by the app lanes; anything the extension needs changed there goes
    // through them. One source of truth for the math keeps this one product.
    alias: { '@app': resolve(here, '../app/src') },
  },
  // Read VITE_* from the app's env files (app/.env.local carries the operator's
  // RPC key) so the site and the extension are configured once, identically.
  envDir: resolve(here, '../app'),
  build: {
    // MV3 forbids remote code; everything must land in the bundle anyway.
    // Modern target keeps top-level await available for the popup if needed.
    target: 'es2022',
    rollupOptions: {
      output: {
        // Deterministic-ish chunk names help store review diffs between versions.
        chunkFileNames: 'assets/[name]-[hash].js',
      },
    },
  },
})
