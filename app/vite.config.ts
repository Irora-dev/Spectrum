import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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

// Brand the STATIC document head from brand.config at build time — the <title>, description,
// and OG / Twitter tags that crawlers and social unfurlers read before any JS runs (the runtime
// re-skin can't reach them). So every operator's tab + social cards carry THEIR name, not "Spectrum".
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
function brandHtml(): Plugin {
  const tagline = brand.tagline?.trim() || 'onchain baskets'
  const title = esc(`${brand.name} · ${tagline}`)
  const desc = esc(`${brand.name}: onchain basket tokens. Each basket is a single token that holds a whole basket of assets.`)
  const siteName = esc(brand.name)
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
            // Same name red line the wizard + studio enforce, re-checked at the write.
            const m = brandConfig.match(/name:\s*("(?:[^"\\]|\\.)*")/)
            const name = m ? (JSON.parse(m[1]) as string) : ''
            if (!name.trim() || name.length > 64 || /spectrum/i.test(name)) return reject(400, 'invalid site name')
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

// base: './' keeps asset URLs relative so the build works under any
// IPFS/ENS gateway path. Clean per-route HTML for IPFS is handled at deploy time.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), brandHtml(), siteHtml(), setupApply()],
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
