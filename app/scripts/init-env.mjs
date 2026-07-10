#!/usr/bin/env node
// Scaffold a local config: copy .env.example → .env.local if it doesn't exist.
// Vite loads .env.local (gitignored), NOT .env.example — so without this copy an
// operator's edits to .env.example are simply ignored. Idempotent: never clobbers
// an existing .env.local.
//
//   npm run init:env

import { existsSync, copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = resolve(APP_DIR, '.env.example')
const dest = resolve(APP_DIR, '.env.local')

if (existsSync(dest)) {
  console.log('.env.local already exists — leaving it untouched.')
  console.log('Edit it, then run `npm run check:config`.')
} else {
  copyFileSync(src, dest)
  console.log('Created .env.local from .env.example.')
  console.log('Fill in your factory + infra addresses, then run `npm run check:config`.')
}
