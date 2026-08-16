import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))

// Firefox's MV3 background is an EVENT PAGE (background.scripts), not a
// service worker — and event-page scripts aren't ES modules, so the worker
// entry is rebuilt here as ONE self-contained IIFE (dynamic imports inlined).
// Everything else in the Firefox build (popup, assets, manifest transform)
// comes from the Chrome dist via scripts/build-firefox.mjs; this config exists
// only to produce that single file.
export default defineConfig({
  resolve: {
    alias: { '@app': resolve(here, '../app/src') },
  },
  envDir: resolve(here, '../app'),
  build: {
    target: 'es2022',
    outDir: 'dist-firefox',
    emptyOutDir: false,
    lib: {
      entry: resolve(here, 'src/sw/index.ts'),
      formats: ['iife'],
      name: 'spectrum_lens_worker',
      fileName: () => 'sw.js',
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
})
