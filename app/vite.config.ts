import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import brand from './src/brand.config'
import site from './src/site.config.json'

// This app ships WITHOUT @types/node on purpose (node_modules is shared with the operator
// repo; auto-included node globals would silently change its typecheck). The node:fs /
// node:path module shims live in vite-node-shim.d.ts; the request/response surface the
// middleware touches is typed locally here. Runtime is real node either way.
type NodeReq = {
  method?: string
  headers: Record<string, string | string[] | undefined>
  on(event: 'data', cb: (chunk: unknown) => void): void
  on(event: 'end', cb: () => void): void
}
type NodeRes = {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body?: string): void
}
/** What the 0x dev bridge reads off connect's request object. `originalUrl`
 *  keeps the full path (connect strips the mount prefix from `url`). */
type BridgeReq = NodeReq & { originalUrl?: string; url?: string }

// Brand the STATIC document head from brand.config at build time — the <title>, description,
// and OG / Twitter tags that crawlers and social unfurlers read before any JS runs (the runtime
// re-skin can't reach them). So every operator's tab + social cards carry THEIR name, not "Spectrum".
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
function brandHtml(): Plugin {
  const tagline = brand.tagline?.trim() || 'onchain baskets'
  const title = esc(`${brand.name} · ${tagline}`)
  const desc = esc(`${brand.name}: onchain basket tokens. Each basket is a single token that holds a whole basket of assets.`)
  const siteName = esc(brand.name)
  let outDir = ''
  return {
    name: 'brand-html',
    transformIndexHtml(html) {
      return html
        .replace(/<title>[\s\S]*?<\/title>/, `<title>${title}</title>`)
        .replace(/(<meta name="description" content=")[^"]*(")/, `$1${desc}$2`)
        .replace(/(<meta property="og:site_name" content=")[^"]*(")/, `$1${siteName}$2`)
        .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${title}$2`)
        .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${desc}$2`)
        .replace(/(<meta property="og:image:alt" content=")[^"]*(")/, `$1${siteName}$2`)
        .replace(/(<meta name="twitter:title" content=")[^"]*(")/, `$1${title}$2`)
        .replace(/(<meta name="twitter:description" content=")[^"]*(")/, `$1${desc}$2`)
    },
    // The PWA manifest is part of the brand surface too (mobile systems audit):
    // hardcoded "Baskets" named every operator's Android install prompt, and
    // absolute URLs broke installability under IPFS/ENS gateway paths (the
    // build's base is './' for exactly that case). public/ files bypass rollup
    // (plain copy), so patch the COPIED file after the bundle closes: branded
    // name, relative start_url + icon srcs.
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      const p = resolve(outDir, 'site.webmanifest')
      if (!existsSync(p)) return
      try {
        const m = JSON.parse(readFileSync(p, 'utf8')) as {
          name: string
          short_name: string
          start_url: string
          icons?: { src: string }[]
        }
        m.name = brand.name
        m.short_name = brand.name
        m.start_url = './'
        for (const icon of m.icons ?? []) icon.src = icon.src.replace(/^\//, './')
        writeFileSync(p, JSON.stringify(m, null, 2))
      } catch {
        /* malformed manifest: ship it untouched rather than fail the build */
      }
    },
  }
}

// The site URL's primary home is the COMMITTED src/site.config.json (the setup studio /
// wizard write it); VITE_SITE_URL remains an override (real env var, or .env.local).
// Substitute the %VITE_SITE_URL% tokens in index.html from that RESOLVED value, order
// 'pre' so no token survives for Vite's own env replacement to second-guess.
function envLocalValue(key: string): string {
  const p = resolve(dirname(fileURLToPath(import.meta.url)), '.env.local')
  if (!existsSync(p)) return ''
  for (const raw of readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1 || line.slice(0, eq).trim() !== key) continue
    let v = line.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    else v = v.replace(/(^|\s)#.*$/, '').trim()
    return v
  }
  return ''
}
function siteHtml(): Plugin {
  const origin = (process.env.VITE_SITE_URL || envLocalValue('VITE_SITE_URL') || site.siteUrl || '')
    .trim()
    .replace(/\/$/, '')
  return {
    name: 'site-html',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html.replace(/%VITE_SITE_URL%/g, origin)
      },
    },
  }
}

// Dev-only write-back for the /setup studio: "Apply to this project" POSTs the three
// generated files here and they land straight in the checkout — no download/file-shuffle
// during onboarding. Exists ONLY in the dev server (apply: 'serve'; middleware is not part
// of any build, so a deployed static site has no such endpoint). Writes exactly three fixed
// paths inside the app dir. The custom-header requirement forces a CORS preflight on any
// cross-origin XHR (which we never answer) and plain form posts can't set headers — so a
// hostile web page can't drive a localhost dev server into rewriting the config.
function setupApply(): Plugin {
  return {
    name: 'setup-apply',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__setup/apply', (rawReq, rawRes) => {
        const req = rawReq as unknown as NodeReq
        const res = rawRes as unknown as NodeRes
        const reject = (code: number, error: string) => {
          res.statusCode = code
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error }))
        }
        if (req.method !== 'POST') return reject(405, 'POST only')
        if (req.headers['x-setup-apply'] !== '1') return reject(403, 'missing X-Setup-Apply header')
        const origin = req.headers.origin
        if (typeof origin === 'string' && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))
          return reject(403, 'cross-origin')
        let body = ''
        req.on('data', (c) => { body += String(c) })
        req.on('end', () => {
          try {
            if (body.length > 128 * 1024) return reject(413, 'payload too large')
            const { brandConfig, envLocal, siteConfig } = JSON.parse(body) as {
              brandConfig?: unknown
              envLocal?: unknown
              siteConfig?: unknown
            }
            if (typeof brandConfig !== 'string' || !brandConfig.includes('export const brand: BrandConfig'))
              return reject(400, 'brandConfig missing or malformed')
            if (typeof envLocal !== 'string' || !envLocal.includes('VITE_ALCHEMY_API_KEY'))
              return reject(400, 'envLocal missing or malformed')
            // The committed deploy identity (site URL + fee wallet) — shape-checked hard:
            // it lands in a committed file.
            if (typeof siteConfig !== 'string') return reject(400, 'siteConfig missing')
            let sc: { siteUrl?: unknown; feeWallet?: unknown; features?: Record<string, unknown> }
            try {
              sc = JSON.parse(siteConfig) as typeof sc
            } catch {
              return reject(400, 'siteConfig is not valid JSON')
            }
            if (typeof sc.siteUrl !== 'string' || sc.siteUrl.length > 2048)
              return reject(400, 'siteConfig.siteUrl malformed')
            if (typeof sc.feeWallet !== 'string' || (sc.feeWallet !== '' && !/^0x[0-9a-fA-F]{40}$/.test(sc.feeWallet)))
              return reject(400, 'siteConfig.feeWallet malformed')
            const feats = sc.features
            if (
              !feats ||
              (['wallet', 'deploy', 'trading', 'swap'] as const).some((k) => typeof feats[k] !== 'boolean')
            )
              return reject(400, 'siteConfig.features malformed')
            if ((feats.deploy || feats.trading || feats.swap) && !feats.wallet)
              return reject(400, 'siteConfig.features: transactional flags require wallet')
            // Same name rule the wizard + studio enforce, re-checked at the write.
            // The /spectrum/i REJECTION IS GONE (it outlived the guard): "Spectrum"
            // is the shipped recommended default (brand.config.ts) and validateSiteName
            // accepts it, so this middleware was 400-ing the studio's own Apply button
            // for anyone who kept the default name — the primary onboarding path in
            // START-HERE Stage 1. Length now mirrors MAX_SITE_NAME (32), not 64.
            const m = brandConfig.match(/name:\s*("(?:[^"\\]|\\.)*")/)
            const name = m ? (JSON.parse(m[1]) as string) : ''
            if (!name.trim() || name.length > 32) return reject(400, 'invalid site name')
            writeFileSync(resolve(server.config.root, 'src/brand.config.ts'), brandConfig)
            writeFileSync(resolve(server.config.root, 'src/site.config.json'), siteConfig)
            writeFileSync(resolve(server.config.root, '.env.local'), envLocal)
            server.config.logger.info(
              '[setup] applied — wrote src/brand.config.ts + src/site.config.json + .env.local; vite now restarts itself with the new setup',
            )
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ ok: true }))
          } catch {
            reject(400, 'invalid JSON body')
          }
        })
      })
    },
  }
}

// Dev-only READ for the /setup studio's Extension panel: proxies
// extension/scripts/status.mjs --json (the append-only introspection contract).
// Serve-only like setupApply — a deployed static site has no such endpoint, and
// the panel degrades to "run this locally". No CORS headers are ever set, so a
// hostile page can trigger but never READ it; it also only reports booleans and
// file names, never credential values (that is status.mjs's own contract).
function setupExtensionStatus(): Plugin {
  return {
    name: 'setup-extension-status',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__setup/extension-status', (rawReq, rawRes) => {
        const req = rawReq as unknown as NodeReq
        const res = rawRes as unknown as NodeRes
        res.setHeader('content-type', 'application/json')
        if (req.method !== 'GET') {
          res.statusCode = 405
          return res.end(JSON.stringify({ ok: false, error: 'GET only' }))
        }
        const extDir = resolve(server.config.root, '../extension')
        if (!existsSync(resolve(extDir, 'scripts/status.mjs'))) {
          return res.end(JSON.stringify({ ok: true, absent: true }))
        }
        execFile(
          process.execPath,
          [resolve(extDir, 'scripts/status.mjs'), '--json'],
          { cwd: extDir, timeout: 10_000 },
          (err, stdout) => {
            if (err) {
              res.statusCode = 500
              return res.end(JSON.stringify({ ok: false, error: 'status.mjs failed' }))
            }
            // Guarded: a throw inside a node-style callback is an uncaught
            // exception that kills the whole dev server, not a 500.
            try {
              res.end(JSON.stringify({ ok: true, status: JSON.parse(stdout) }))
            } catch {
              res.statusCode = 500
              res.end(JSON.stringify({ ok: false, error: 'status.mjs printed non-JSON' }))
            }
          },
        )
      })
    },
  }
}

// THE 0x DEV BRIDGE (2026-08-12, portfolio-execution arming). In production
// the browser's quote calls to /api/zerox/* are answered by the Netlify edge
// function (app/netlify/edge-functions/zerox.ts); plain `vite` serves no such
// route, so on localhost every quote read-failed by construction. This mounts
// THE SAME tested handler (src/lib/spectrum/zerox-proxy-handler.ts — platform-
// agnostic Request→Response by design) on the dev server. The key stays
// SERVER-SIDE: `ZEROX_API_KEY` (no VITE_ prefix, so it can never be inlined
// into the client bundle) is read from .env.local AT REQUEST TIME via the same
// envLocalValue helper the site-html plugin uses — a key added or rotated
// there answers on the next request, no restart needed. With no key the
// handler's own NO_UPSTREAM_KEY (503) flows through, which the client
// classifies read-failed and words as "we could not reach the exchange" —
// never a fact about the market. Serve-only: no deployed build carries this.
function zeroxDevBridge(): Plugin {
  return {
    name: 'zerox-dev-bridge',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/zerox', (rawReq, rawRes) => {
        const req = rawReq as unknown as BridgeReq
        const res = rawRes as unknown as NodeRes
        void (async () => {
          try {
            const host = typeof req.headers.host === 'string' ? req.headers.host : 'localhost'
            // connect strips the mount path from url; originalUrl carries the
            // full /api/zerox/... path the handler's prefix-strip expects
            const full = req.originalUrl ?? `/api/zerox${req.url ?? ''}`
            // The handler is loaded through vite's OWN module runner rather
            // than a static import: a static import would pull the src tree
            // into the node tsconfig's program (which carries no dom lib), and
            // the runner keeps the tested source as the single artifact vite
            // transforms either way. The local types below are the handler's
            // contract, honored by the paired tests it already has.
            type HeadersLike = { set(k: string, v: string): void }
            type ZeroxHandler = (
              request: unknown,
              env: { apiKey: string | null; canonicalOrigin: string | null; extraOrigins: readonly string[] },
            ) => Promise<{ status: number; headers: { forEach(cb: (v: string, k: string) => void): void }; text(): Promise<string> }>
            const { handleZeroxProxy } = (await server.ssrLoadModule('/src/lib/spectrum/zerox-proxy-handler.ts')) as {
              handleZeroxProxy: ZeroxHandler
            }
            // The fetch classes via globalThis: present at runtime (node 18+)
            // but not ambient names under the node tsconfig.
            const G = globalThis as Record<string, unknown>
            const HeadersCtor = G.Headers as new () => HeadersLike
            const RequestCtor = G.Request as new (url: string, init?: { method?: string; headers?: HeadersLike }) => unknown
            const headers = new HeadersCtor()
            for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
            const out = await handleZeroxProxy(new RequestCtor(`http://${host}${full}`, { method: req.method ?? 'GET', headers }), {
              apiKey: process.env.ZEROX_API_KEY || envLocalValue('ZEROX_API_KEY') || null,
              canonicalOrigin: null, // dev: the request's own origin is the site
              extraOrigins: [],
            })
            res.statusCode = out.status
            out.headers.forEach((v: string, k: string) => res.setHeader(k, v))
            res.end(await out.text())
          } catch {
            res.statusCode = 502
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ name: 'UPSTREAM_UNREACHABLE', message: 'The dev 0x bridge failed to answer.' }))
          }
        })()
      })
    },
  }
}

// base: './' keeps asset URLs relative so the build works under any
// IPFS/ENS gateway path. Clean per-route HTML for IPFS is handled at deploy time.
export default defineConfig({
  base: './',
  // Stryker's sandbox (.stryker-tmp) lives inside the app while a mutation
  // run is active; vite's watcher picking it up mid-run resolved public
  // assets INTO the half-built sandbox and error-overlayed the whole dev
  // server (measured 2026-08-05 — the review screenshot caught it). The
  // dev server and the mutation harness must never see each other.
  server: { watch: { ignored: ['**/.stryker-tmp/**'] } },
  plugins: [react(), tailwindcss(), brandHtml(), siteHtml(), setupApply(), setupExtensionStatus(), zeroxDevBridge()],
  build: {
    rollupOptions: {
      output: {
        // Split heavy vendors into their own cacheable chunks so the initial
        // parse is smaller and chunks download in parallel. three is also
        // lazy-loaded (decorative background), so it stays off first paint.
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('/three/')) return 'three'
          if (/\/(recharts|d3-[a-z]+|victory-vendor|internmap)\//.test(id)) return 'charts'
          if (/\/(react|react-dom|react-router|react-router-dom|scheduler|use-sync-external-store)\//.test(id))
            return 'react-vendor'
          if (/\/(wagmi|@wagmi|viem|ox|abitype|@tanstack|@coinbase|@walletconnect|@reown|@safe-global|@metamask)/.test(id))
            return 'web3'
        },
      },
    },
  },
})
