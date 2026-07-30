// Evidence for the LiFi execution-target allowlist (redteam F-4): what address
// does li.quest ACTUALLY ask us to approve + call, per chain, across several
// route shapes? Read-only. Run: npx vite-node scripts/lifi-target-probe.ts
import { createPublicClient, http, type Address } from 'viem'

const FROM = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' as Address
const NATIVE = '0x0000000000000000000000000000000000000000'
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const USDG_RH = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
const AERO = '0x940181a94A35A4569E4529A3CDfB74e38FD98631'
const LINK = '0x514910771AF9Ca656af840dff83E8264EcF986CA'
const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC'

const RPC: Record<number, string> = {
  1: 'https://eth.drpc.org',
  8453: 'https://mainnet.base.org',
  4663: 'https://rpc.mainnet.chain.robinhood.com',
}

const CASES: { label: string; chainId: number; fromChainId?: number; from: string; to: string; amount: string }[] = [
  { label: 'Base ETH→USDC', chainId: 8453, from: NATIVE, to: USDC_BASE, amount: (10n ** 17n).toString() },
  { label: 'Base AERO→USDC', chainId: 8453, from: AERO, to: USDC_BASE, amount: (100n * 10n ** 18n).toString() },
  { label: 'Base USDC→AERO', chainId: 8453, from: USDC_BASE, to: AERO, amount: (100n * 10n ** 6n).toString() },
  { label: 'Eth LINK→USDC', chainId: 1, from: LINK, to: USDC_ETH, amount: (10n * 10n ** 18n).toString() },
  { label: 'Eth USDC→LINK', chainId: 1, from: USDC_ETH, to: LINK, amount: (200n * 10n ** 6n).toString() },
  { label: 'RH ETH→USDG', chainId: 4663, from: NATIVE, to: USDG_RH, amount: (10n ** 17n).toString() },
  { label: 'RH NVDA→USDG', chainId: 4663, from: NVDA, to: USDG_RH, amount: (10n ** 18n).toString() },
  { label: 'RH USDG→NVDA', chainId: 4663, from: USDG_RH, to: NVDA, amount: (200n * 10n ** 6n).toString() },
  { label: 'CROSS Base ETH→RH USDG', chainId: 4663, fromChainId: 8453, from: NATIVE, to: USDG_RH, amount: (10n ** 17n).toString() },
  { label: 'CROSS Eth USDC→Base USDC', chainId: 8453, fromChainId: 1, from: USDC_ETH, to: USDC_BASE, amount: (250n * 10n ** 6n).toString() },
]

const seen = new Map<string, { chains: Set<number>; tools: Set<string>; cases: number }>()

for (const c of CASES) {
  const src = c.fromChainId ?? c.chainId
  const q = new URLSearchParams({
    fromChain: String(src),
    toChain: String(c.chainId),
    fromToken: c.from,
    toToken: c.to,
    fromAmount: c.amount,
    fromAddress: FROM,
    slippage: '0.01',
  })
  try {
    const r = await fetch(`https://li.quest/v1/quote?${q}`, { headers: { Accept: 'application/json' } })
    const j = (await r.json()) as Record<string, any>
    if (!r.ok) {
      console.log(`⚠ ${c.label}: HTTP ${r.status} ${String(j?.message).slice(0, 60)}`)
      continue
    }
    const to = String(j.transactionRequest?.to ?? '')
    const spender = String(j.estimate?.approvalAddress ?? '')
    const tool = String(j.tool ?? '?')
    const key = to.toLowerCase()
    const rec = seen.get(key) ?? { chains: new Set<number>(), tools: new Set<string>(), cases: 0 }
    rec.chains.add(src)
    rec.tools.add(tool)
    rec.cases++
    seen.set(key, rec)
    console.log(`${c.label}\n   src chain ${src} · to ${to} · spender ${spender} · same=${to.toLowerCase() === spender.toLowerCase()} · tool ${tool}`)
  } catch (e) {
    console.log(`⚠ ${c.label}: ${e instanceof Error ? e.message : e}`)
  }
  await new Promise((r) => setTimeout(r, 700))
}

console.log('\n── DISTINCT EXECUTION TARGETS ──')
for (const [addr, rec] of seen) {
  const chains = [...rec.chains]
  let codeSize = 0
  try {
    const client = createPublicClient({ transport: http(RPC[chains[0]]) })
    const code = await client.getCode({ address: addr as Address })
    codeSize = code ? (code.length - 2) / 2 : 0
  } catch {
    /* probe only */
  }
  console.log(`${addr}\n   src chains [${chains.join(', ')}] · ${rec.cases} routes · tools {${[...rec.tools].join(',')}} · code ${codeSize} bytes`)
}
console.log(`\n${seen.size} distinct target(s) across ${CASES.length} route shapes`)
