#!/usr/bin/env node
// Generate public/sitemap.xml from VITE_SITE_URL + the public content routes. Runs in the
// prebuild hook (after check-config). No origin set → leaves the shipped stub and prints a
// note (a sitemap needs ABSOLUTE urls, and the kit ships no origin — never points at anyone
// else's property). Set VITE_SITE_URL and rebuild to emit your own.
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Read a VITE_ var the way Vite resolves it: a real shell var wins, else .env.local.
function envValue(key) {
  if (process.env[key]) return process.env[key]
  const p = resolve(APP_DIR, '.env.local')
  if (!existsSync(p)) return ''
  for (const raw of readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1 || line.slice(0, eq).trim() !== key) continue
    let v = line.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    return v
  }
  return ''
}

// Public, crawlable content routes (dynamic token/creator pages + wallet/flag-gated pages excluded).
const ROUTES = ['/', '/explore', '/launch', '/faq', '/learn', '/docs', '/terms', '/privacy', '/risk']
function siteConfigValue(key) {
  try {
    return String(JSON.parse(readFileSync(resolve(APP_DIR, 'src/site.config.json'), 'utf8'))[key] ?? '')
  } catch {
    return ''
  }
}
const origin = (envValue('VITE_SITE_URL') || siteConfigValue('siteUrl')).trim().replace(/\/$/, '')
const out = resolve(APP_DIR, 'public/sitemap.xml')

if (!origin) {
  console.log('sitemap: no site URL (src/site.config.json siteUrl / VITE_SITE_URL) — leaving the stub (a sitemap needs an absolute origin).')
  process.exit(0)
}

const urls = ROUTES.map((r) => `  <url><loc>${origin}${r}</loc></url>`).join('\n')
const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
writeFileSync(out, xml)
console.log(`sitemap: wrote ${ROUTES.length} routes for ${origin}`)
