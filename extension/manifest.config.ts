import { defineManifest } from '@crxjs/vite-plugin'
// Relative import on purpose: Vite loads this config before the @app alias
// exists. WHITE-LABEL (the owner 2026-08-02): the extension ships in the kit and
// carries the OPERATOR's wordmark, exactly like the site — never hardcode
// "Spectrum" into an operator-facing string.
import brand from '../app/src/brand.config'
import site from '../app/src/site.config.json'
import pkg from './package.json'

// The operator's site origin, when configured at build time. It gates the
// detect-and-offer content script: an unconfigured build ships NO content
// script at all, keeping the minimal-permissions posture intact.
function siteOrigin(): string | null {
  const raw = (process.env.VITE_SITE_URL || (site as { siteUrl?: string }).siteUrl || '').trim()
  if (!raw) return null
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null
  } catch {
    return null
  }
}
const origin = siteOrigin()

// The extension NOTICES, the site EXECUTES. This manifest is the enforcement
// surface for that rule: no tabs, no <all_urls>, no content scripts, no wallet
// APIs — alarms + storage + notifications, and host access for the READ
// endpoints only (the same RPC/pricing hosts the site itself reads). A crypto
// extension asking for more is indistinguishable from a malicious one.
export default defineManifest({
  manifest_version: 3,
  name: `${brand.name} · Portfolio Lens`,
  version: pkg.version,
  // es2022 output + the extended-lifetime SW behaviour the poll relies on.
  minimum_chrome_version: '110',
  description:
    'Watches your basket portfolio across chains and hands off to your site to act. Read-only: it never connects, never signs, never asks for a seed phrase.',
  icons: {
    16: 'icons/icon-16.png',
    32: 'icons/icon-32.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  },
  action: {
    default_popup: 'src/popup/index.html',
    default_title: `${brand.name} portfolio`,
  },
  background: {
    service_worker: 'src/sw/index.ts',
    type: 'module',
  },
  permissions: ['alarms', 'storage', 'notifications'],
  // Detect-and-offer: on the operator's OWN origin only, the marker stamps
  // `data-spectrum-lens` so the site can offer the install exactly when it's
  // absent. Present only in site-configured builds.
  ...(origin
    ? {
        content_scripts: [
          {
            matches: [`${origin}/*`],
            js: ['src/content/marker.ts'],
            run_at: 'document_start' as const,
          },
        ],
      }
    : {}),
  host_permissions: [
    // Public per-chain RPC fallbacks (lib/chain/rpc.ts) + the keyed Alchemy hosts.
    'https://base-rpc.publicnode.com/*',
    'https://ethereum-rpc.publicnode.com/*',
    'https://rpc.mainnet.chain.robinhood.com/*',
    'https://*.g.alchemy.com/*',
    // Pricing reads the lib does alongside RPC (DexScreener, keyless).
    'https://api.dexscreener.com/*',
  ],
})
