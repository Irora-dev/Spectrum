// ═════════════════════════════════════════════════════════════════════════════
// ONE-LEG PROBE (2026-08-13) — does the factory itself refuse a basket that
// holds a SINGLE asset, or is "a basket needs two assets" a rule WE invented?
//
// Owner's question (the owner): "for simplicity can't we allow a basket to just
// have one asset? since the multi-chain baskets can always have one asset on
// one chain and a future upgrade could always add more."
//
// The answer has to come from the contract, not from reading our own UI. So
// this drives the REAL deploy path — findBestPool → toBasketEntries → mineSalt
// (predictTokenAddress is the oracle) → startSqrtPriceX96ForDollarNav →
// currentDeployPrice → eth_call simulate of deployBasket — with a ONE-leg
// basket at weight 100, and with a TWO-leg control basket through the exact
// same code so a green control proves the harness itself is sound.
//
// Read-only: every call is eth_call. The deployer is a dummy address funded by
// a state override, so nothing is signed and no key is needed.
//
//   npx vite-node scripts/one-leg-probe.ts
// ═════════════════════════════════════════════════════════════════════════════
import { parseEther, type Address, type Hex } from 'viem'
import { findBestPool } from '../src/lib/pools'
import { toBasketEntries, startSqrtPriceX96ForDollarNav, type DeployAssetInput } from '../src/lib/spectrum/deploy'
import { mineSalt } from '../src/lib/spectrum/salt-mining'
import { factoryDeployAbi, type FeeConfigInput } from '../src/lib/spectrum/abis-v2'
import { clientFor } from '../src/lib/chain/rpc'
import { chainCfg } from '../src/lib/chain/chains'

/** A dummy deployer; the salt is mined FOR it and the override funds it. */
const DEPLOYER = '0x1111111111111111111111111111111111111111' as Address

const FEE: FeeConfigInput = {
  basketFeeBps: 100,
  creatorShareBps: 0,
  creatorPayout: '0x0000000000000000000000000000000000000000',
  launcher: '0x0000000000000000000000000000000000000000',
}

interface Target {
  label: string
  chainId: number
  factory: Address
  /** Two deep, V3/V4-routable assets on that chain. */
  assets: Address[]
}

const TARGETS: Target[] = [
  {
    label: 'REHEARSAL · Base 8453',
    chainId: 8453,
    factory: '0x3705cd325b590803323a7482efc6ce6df1b64778',
    assets: [
      '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', // cbBTC
      '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', // cbETH
    ],
  },
  {
    label: 'REHEARSAL · Ethereum 1',
    chainId: 1,
    factory: '0x26b78cb590a53EF7a4c91845E2D68761F4aF21d0',
    assets: [
      '0x514910771AF9Ca656af840dff83E8264EcF986CA', // LINK
      '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', // UNI
    ],
  },
  {
    label: 'PRODUCTION · Ethereum 1',
    chainId: 1,
    factory: '0x4d3590a5B0aCee04Bb7Ab721B23fDdae8B880486',
    assets: [
      '0x514910771AF9Ca656af840dff83E8264EcF986CA', // LINK
      '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', // UNI
    ],
  },
  {
    label: 'PRODUCTION · Base 8453',
    chainId: 8453,
    factory: '0xa60ce83A4048f2157A65d596002541311D694E5D',
    assets: [
      '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', // cbBTC
      '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', // cbETH
    ],
  },
]

/** Unwrap viem's error onion down to the sentence that actually names the cause. */
function revertOf(e: unknown): string {
  const err = e as { shortMessage?: string; details?: string; metaMessages?: string[]; message?: string; cause?: unknown }
  const bits: string[] = []
  if (err?.shortMessage) bits.push(err.shortMessage)
  if (err?.metaMessages?.length) bits.push(err.metaMessages.slice(0, 3).join(' | '))
  if (err?.details) bits.push(`details: ${err.details}`)
  if (!bits.length && err?.message) bits.push(err.message.split('\n').slice(0, 4).join(' '))
  let cause = err?.cause as { shortMessage?: string; data?: unknown; message?: string } | undefined
  for (let i = 0; i < 4 && cause; i++) {
    if (cause.data) bits.push(`data: ${JSON.stringify(cause.data)}`)
    cause = (cause as { cause?: unknown }).cause as typeof cause
  }
  return bits.join('  ·  ') || String(e)
}

async function attempt(t: Target, legs: number) {
  const cfg = chainCfg(t.chainId)
  const client = clientFor(t.chainId)
  const tag = `${legs}-LEG`

  const picked = t.assets.slice(0, legs)
  const inputs: DeployAssetInput[] = []
  for (const a of picked) {
    const r = await findBestPool(a, t.chainId)
    inputs.push({ address: a, decimals: r.decimals, route: r.route, symbol: r.symbol })
    console.log(`    route ${a.slice(0, 10)}… → venue ${r.route.venue} (${r.best.label})`)
  }
  // Σ = 100 either way: one leg is simply 100%.
  const weights = legs === 1 ? [100] : [50, 50]
  const basket = toBasketEntries(inputs, weights, t.chainId)
  console.log(`    basket assembled: ${basket.length} entry(ies), weights bps ${basket.map((b) => b.weight).join('+')}`)

  // predictTokenAddress is the oracle — a basket shape the factory rejects
  // fails HERE, loudly, before any salt is found.
  const mined = await mineSalt({
    factory: t.factory,
    chainId: t.chainId,
    basket,
    deployer: DEPLOYER,
    feeConfig: FEE,
    forceMainThread: true,
    maxAttempts: 400_000,
  })
  console.log(`    salt mined (${mined.mode}, ${mined.attempts} tries) → predicted ${mined.predicted}`)

  const price = (await client.readContract({
    address: t.factory,
    abi: factoryDeployAbi,
    functionName: 'currentDeployPrice',
  })) as bigint
  const startSqrtPriceX96 = startSqrtPriceX96ForDollarNav(mined.predicted, cfg.usdc as Address)

  await client.simulateContract({
    address: t.factory,
    abi: factoryDeployAbi,
    functionName: 'deployBasket',
    args: [mined.salt as Hex, `Probe ${tag}`, `PRB${legs}`, basket, startSqrtPriceX96, price, FEE],
    value: price,
    account: DEPLOYER,
    stateOverride: [{ address: DEPLOYER, balance: parseEther('1000') }],
  })
  console.log(`    deploy price ${price} wei`)
}

async function main() {
  for (const t of TARGETS) {
    console.log(`\n${'═'.repeat(78)}\n${t.label} · factory ${t.factory}\n${'═'.repeat(78)}`)
    const code = await clientFor(t.chainId).getCode({ address: t.factory })
    console.log(`  bytecode: ${code && code !== '0x' ? `${(code.length - 2) / 2} bytes` : 'NONE — not a contract on this chain'}`)
    if (!code || code === '0x') continue

    for (const legs of [2, 1]) {
      console.log(`\n  ── ${legs}-LEG ${legs === 2 ? '(CONTROL — must pass for the 1-leg answer to mean anything)' : '(THE QUESTION)'} ──`)
      try {
        await attempt(t, legs)
        console.log(`  ✅ ${legs}-LEG SIMULATES — the factory accepts it`)
      } catch (e) {
        console.log(`  ❌ ${legs}-LEG REVERTS`)
        console.log(`     ${revertOf(e)}`)
      }
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
