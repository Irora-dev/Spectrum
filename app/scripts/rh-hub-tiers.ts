// One-off ground truth (lab, 2026-07-29): per-tier depth of the {ETH, USDG}
// hub pool + settlement-paired {USDG, stock} pools for AAPL/TSLA (the V4Q
// premise). Read-only. Run: npx vite-node scripts/rh-hub-tiers.ts
import { encodeAbiParameters, formatUnits, keccak256, toHex, zeroAddress, type Address } from 'viem'
import { clientFor } from '../src/lib/chain/rpc'
import { chainCfg } from '../src/lib/chain/chains'
import { V4_POOLS_SLOT } from '../src/lib/chain/constants'
import { poolManagerExtsloadAbi } from '../src/lib/pools/abis'
import { v4PoolId } from '../src/lib/pools/v4-usd'
import { NATIVE_ETH, V4_PROBE_TIERS, type PoolKey } from '../src/lib/pools/types'

const CHAIN = 4663
const cfg = chainCfg(CHAIN)
const client = clientFor(CHAIN)
const AAPL = '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9' as Address
const TSLA = '0x322F0929c4625eD5bAd873c95208D54E1c003b2d' as Address

// currency0 < currency1 by address (uint160 order)
function sortedKey(a: Address, b: Address, fee: number, tickSpacing: number): PoolKey {
  const [c0, c1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a]
  return { currency0: c0, currency1: c1, fee, tickSpacing, hooks: zeroAddress }
}

// side-labelled real balances aren't readable via extsload for both currencies;
// report the virtual ETH-equivalent of currency0 the same way detection does.
async function depth0(id: `0x${string}`): Promise<{ sqrtP: bigint; liq: bigint; amt0: number }> {
  const base = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [id, V4_POOLS_SLOT]))
  const liquiditySlot = toHex(BigInt(base) + 3n, { size: 32 })
  const [slot0Word, liqWord] = await Promise.all([
    client.readContract({ address: cfg.poolManager!, abi: poolManagerExtsloadAbi, functionName: 'extsload', args: [base] }),
    client.readContract({ address: cfg.poolManager!, abi: poolManagerExtsloadAbi, functionName: 'extsload', args: [liquiditySlot] }),
  ])
  const sqrtP = BigInt(slot0Word) & ((1n << 160n) - 1n)
  const liq = BigInt(liqWord) & ((1n << 128n) - 1n)
  const amt0 = sqrtP === 0n || liq === 0n ? 0 : Number(formatUnits((liq << 96n) / sqrtP, 18))
  return { sqrtP, liq, amt0 }
}

async function main() {
  console.log('— {ETH, USDG} hub pool, per tier (virtual ETH-side amount0) —')
  for (const t of V4_PROBE_TIERS) {
    const id = v4PoolId({ currency0: NATIVE_ETH, currency1: cfg.usdc!, fee: t.fee, tickSpacing: t.tickSpacing, hooks: zeroAddress })
    const d = await depth0(id)
    console.log(`  ${String(t.fee).padStart(6)}/${String(t.tickSpacing).padEnd(4)} liq=${d.liq === 0n ? '0' : 'yes'} ethSide=${d.amt0.toFixed(3)}`)
  }
  for (const [sym, addr] of [['AAPL', AAPL], ['TSLA', TSLA]] as const) {
    console.log(`— {USDG, ${sym}} settlement-paired, per tier (amount0 of lower-address currency) —`)
    for (const t of V4_PROBE_TIERS) {
      const key = sortedKey(cfg.usdc!, addr, t.fee, t.tickSpacing)
      const d = await depth0(v4PoolId(key))
      const c0 = key.currency0.toLowerCase() === cfg.usdc!.toLowerCase() ? 'USDG' : sym
      console.log(`  ${String(t.fee).padStart(6)}/${String(t.tickSpacing).padEnd(4)} liq=${d.liq === 0n ? '0' : 'yes'} sqrtP=${d.sqrtP === 0n ? '0' : 'set'} (c0=${c0})`)
    }
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
