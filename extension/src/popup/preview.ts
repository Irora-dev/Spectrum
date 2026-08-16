// Review harness — NOT part of the extension. Serves the popup in a plain
// browser tab with a faked chrome.* and fixture data so the surface can be
// screenshotted and reviewed without loading the unpacked extension.
//
//   npx vite dev → http://localhost:5173/src/popup/preview.html
//   variants: ?state=empty | ?state=loading | ?state=degraded | ?state=failing
//   (default: full)

import type { PortfolioSnapshot } from '../shared/portfolio'

const params = new URLSearchParams(location.search)
const variant = params.get('state') ?? 'full'

const A = {
  weth: '0x4200000000000000000000000000000000000006',
  cbbtc: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf',
  link: '0x514910771af9ca656af840dff83e8264ecf986ca',
  cash: '0x020bfc650a365f8bb26819deaabf3e21291018b4',
  uni: '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984',
  aero: '0x940181a94a35a4569e4529a3cdfb74e38fd98631',
}

const contrib = (basketSymbol: string, basketAddress: string, chainId: number, valueUsd: number) => ({
  basketSymbol,
  basketAddress,
  chainId,
  valueUsd,
})

const snapshot: PortfolioSnapshot = {
  v: 1,
  at: Date.now() - 4 * 60_000,
  address: '0x1111111111111111111111111111111111111111',
  totalUsd: 12_482.11,
  change24hPct: 2.34,
  change24hExcluded: variant === 'degraded' ? 1 : 0,
  heldCount: 3,
  createdCount: 1,
  assets: [
    {
      key: `8453:${A.weth}`, address: A.weth, symbol: 'WETH', chainId: 8453, pct: 31.2, valueUsd: 3894.4, basketCount: 3,
      contributions: [contrib('BLUECHIP', '0xb1', 8453, 2140.9), contrib('DEFI5', '0xb2', 1, 1210.2), contrib('HOODMIX', '0xb3', 4663, 543.3)],
    },
    {
      key: `8453:${A.cbbtc}`, address: A.cbbtc, symbol: 'cbBTC', chainId: 8453, pct: 22.6, valueUsd: 2820.9, basketCount: 2,
      contributions: [contrib('BLUECHIP', '0xb1', 8453, 1980.4), contrib('DEFI5', '0xb2', 1, 840.5)],
    },
    {
      key: `1:${A.link}`, address: A.link, symbol: 'LINK', chainId: 1, pct: 14.8, valueUsd: 1847.4, basketCount: 1,
      contributions: [contrib('DEFI5', '0xb2', 1, 1847.4)],
    },
    {
      key: `4663:${A.cash}`, address: A.cash, symbol: 'CASHCAT', chainId: 4663, pct: 12.1, valueUsd: 1510.3, basketCount: 1,
      contributions: [contrib('HOODMIX', '0xb3', 4663, 1510.3)],
    },
    {
      key: `1:${A.uni}`, address: A.uni, symbol: 'UNI', chainId: 1, pct: 10.9, valueUsd: 1360.5, basketCount: 2,
      contributions: [contrib('DEFI5', '0xb2', 1, 900.1), contrib('BLUECHIP', '0xb1', 8453, 460.4)],
    },
    {
      key: `8453:${A.aero}`, address: A.aero, symbol: 'AERO', chainId: 8453, pct: 8.4, valueUsd: 1048.5, basketCount: 1,
      contributions: [contrib('BLUECHIP', '0xb1', 8453, 1048.5)],
    },
  ],
  held: [
    { chainId: 8453, address: '0xb1', symbol: 'BLUECHIP', name: 'Blue Chip Basket', balance: 12.4, valueUsd: 6200, change24hPct: 3.1 },
    { chainId: 1, address: '0xb2', symbol: 'DEFI5', name: 'DeFi Five', balance: 40, valueUsd: 3800, change24hPct: -1.2 },
    { chainId: 4663, address: '0xb3', symbol: 'HOODMIX', name: 'Hood Mix', balance: 100, valueUsd: 2482.11, change24hPct: 6.8 },
  ],
  created: [
    { chainId: 8453, address: '0xb1', symbol: 'BLUECHIP', name: 'Blue Chip Basket', aumUsd: 48_200, change24hPct: 3.1 },
  ],
  chainIds: [8453, 1, 4663],
  chainsFailed: variant === 'degraded' ? [1] : [],
}

const settings = {
  'settings/v1': {
    address: variant === 'empty' ? undefined : snapshot.address,
    pollMinutes: 15,
    siteUrl: 'https://spectrum.example',
    targets:
      variant === 'empty'
        ? {}
        : { [`8453:${A.weth}`]: 25, [`8453:${A.cbbtc}`]: 25, [`1:${A.link}`]: 15, [`4663:${A.cash}`]: 15 },
  },
  'rules/v1':
    variant === 'empty'
      ? []
      : [
          { id: 'r1', type: 'drift', enabled: true, pts: 3 },
          { id: 'r2', type: 'value', enabled: false, belowUsd: 10_000 },
        ],
}

// The degraded fixture must be a state readPortfolio can actually produce:
// a failed chain's rows are MISSING and every figure shrinks accordingly —
// never "the banner says ethereum failed while ethereum rows render below".
function degradeSnapshot(s: PortfolioSnapshot, failedChain: number): PortfolioSnapshot {
  const held = s.held.filter((h) => h.chainId !== failedChain)
  const kept = s.assets.filter((a) => a.chainId !== failedChain)
  const exposureTotal = kept.reduce((sum, a) => sum + a.valueUsd, 0)
  return {
    ...s,
    held,
    heldCount: held.length,
    totalUsd: held.reduce((sum, h) => sum + h.valueUsd, 0),
    assets: kept
      .map((a) => ({ ...a, pct: exposureTotal > 0 ? (a.valueUsd / exposureTotal) * 100 : 0 }))
      .sort((a, b) => b.valueUsd - a.valueUsd),
    created: s.created.filter((b) => b.chainId !== failedChain),
    chainsFailed: [failedChain],
  }
}

const local: Record<string, unknown> =
  variant === 'loading'
    ? {}
    : variant === 'failing'
      ? { 'backoff/v1': { failures: 2, untilMs: Date.now() + 600_000 } }
      : { 'snapshot/v1': variant === 'degraded' ? degradeSnapshot(snapshot, 1) : snapshot }

function fakeArea(seed: Record<string, unknown>) {
  const store = new Map(Object.entries(seed))
  return {
    get: (key: string) => Promise.resolve(store.has(key) ? { [key]: store.get(key) } : {}),
    set: (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) store.set(k, v)
      return Promise.resolve()
    },
    remove: (key: string) => {
      store.delete(key)
      return Promise.resolve()
    },
  }
}

;(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: fakeArea(local),
    sync: fakeArea(settings),
    onChanged: { addListener: () => undefined, removeListener: () => undefined },
  },
  runtime: {
    sendMessage: (_msg: unknown, cb?: (r: unknown) => void) =>
      cb?.(variant === 'failing' ? { ok: false, reason: 'read-failed' } : { ok: true }),
    get lastError() {
      return undefined
    },
  },
}

// ?tall=1 unlocks the 600px window so the WHOLE column lays out for a
// full-page screenshot (the popup itself scrolls internally).
if (params.get('tall')) {
  const style = document.createElement('style')
  style.textContent =
    'html, body, #root { height: auto !important; } body { overflow: visible !important; } .popup-scroll { overflow: visible !important; }'
  document.head.appendChild(style)
}

void import('./main')
