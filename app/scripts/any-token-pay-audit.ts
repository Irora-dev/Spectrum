// Any-token pay side — LIVE route audit (read-only; nothing is signed).
// Exercises the EXACT code path the console uses (fetchLifiQuote + the hostile-
// input parse) for real tokens on every shipped chain, both directions, plus
// one cross-chain funding quote. Run: npx vite-node scripts/any-token-pay-audit.ts
import type { Address } from 'viem'
import { fetchLifiQuote, LIFI_NATIVE } from '../src/lib/spectrum/lifi'

// A famous funded EOA — quotes only consider the address shape, we never sign.
const FROM = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' as Address

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address
const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address
const USDG_RH = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address

const CASES: {
  label: string
  chainId: number
  fromChainId?: number
  fromToken: Address
  toToken: Address
  fromAmount: bigint
  toDecimals: number
}[] = [
  // ── Base 8453: buy side (token → settlement) and sell side (settlement → token)
  { label: 'Base · AERO → USDC (buy pay-leg)', chainId: 8453, fromToken: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', toToken: USDC_BASE, fromAmount: 100n * 10n ** 18n, toDecimals: 6 },
  { label: 'Base · DEGEN → USDC (buy pay-leg)', chainId: 8453, fromToken: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', toToken: USDC_BASE, fromAmount: 10_000n * 10n ** 18n, toDecimals: 6 },
  { label: 'Base · USDC → AERO (sell receive-leg)', chainId: 8453, fromToken: USDC_BASE, toToken: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', fromAmount: 100n * 10n ** 6n, toDecimals: 18 },
  // ── Ethereum 1
  { label: 'Ethereum · LINK → USDC (buy pay-leg)', chainId: 1, fromToken: '0x514910771AF9Ca656af840dff83E8264EcF986CA', toToken: USDC_ETH, fromAmount: 10n * 10n ** 18n, toDecimals: 6 },
  { label: 'Ethereum · USDC → UNI (sell receive-leg)', chainId: 1, fromToken: USDC_ETH, toToken: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', fromAmount: 200n * 10n ** 6n, toDecimals: 18 },
  // ── Robinhood 4663: the stock tokens (the pay side that matters most there)
  { label: 'Robinhood · NVDA → USDG (buy pay-leg)', chainId: 4663, fromToken: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', toToken: USDG_RH, fromAmount: 1n * 10n ** 18n, toDecimals: 6 },
  { label: 'Robinhood · AAPL → USDG (buy pay-leg)', chainId: 4663, fromToken: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9', toToken: USDG_RH, fromAmount: 1n * 10n ** 18n, toDecimals: 6 },
  { label: 'Robinhood · USDG → TSLA (sell receive-leg)', chainId: 4663, fromToken: USDG_RH, toToken: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d', fromAmount: 300n * 10n ** 6n, toDecimals: 18 },
  { label: 'Robinhood · ETH → USDG (regression: the existing hub leg)', chainId: 4663, fromToken: LIFI_NATIVE, toToken: USDG_RH, fromAmount: 10n ** 17n, toDecimals: 6 },
  // ── Cross-chain funding (BridgeFund's quote path)
  { label: 'CROSS · Base ETH → Robinhood USDG (funding)', chainId: 4663, fromChainId: 8453, fromToken: LIFI_NATIVE, toToken: USDG_RH, fromAmount: 10n ** 17n, toDecimals: 6 },
  { label: 'CROSS · Ethereum USDC → Base USDC (funding)', chainId: 8453, fromChainId: 1, fromToken: USDC_ETH, toToken: USDC_BASE, fromAmount: 250n * 10n ** 6n, toDecimals: 6 },
]

const fmt = (raw: bigint, d: number) => (Number(raw) / 10 ** d).toLocaleString('en-US', { maximumFractionDigits: 6 })

let pass = 0
let fail = 0
for (const c of CASES) {
  try {
    const q = await fetchLifiQuote({
      chainId: c.chainId,
      fromChainId: c.fromChainId,
      fromToken: c.fromToken,
      toToken: c.toToken,
      fromAmount: c.fromAmount,
      fromAddress: FROM,
      slippageBps: 100,
    })
    const floorPct = Number((q.toAmountMin * 10_000n) / q.toAmount) / 100
    console.log(
      `✅ ${c.label}\n   → ${fmt(q.toAmount, c.toDecimals)} (floor ${fmt(q.toAmountMin, c.toDecimals)}, ${floorPct}%) via ${q.tool}` +
        `${q.crossChain ? ' · CROSS-CHAIN (async settle)' : ''} · spender==target ✓ (parse-enforced)`,
    )
    pass++
  } catch (e) {
    console.log(`❌ ${c.label}\n   ${e instanceof Error ? e.message : e}`)
    fail++
  }
  await new Promise((r) => setTimeout(r, 600)) // keyless rate-limit courtesy
}
console.log(`\n${pass} routes OK · ${fail} failed`)
