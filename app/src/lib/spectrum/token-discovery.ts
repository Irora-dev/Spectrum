import { erc20Abi, type Address } from 'viem'
import { chainCfg } from '../chain/chains'
import { clientFor, hasAlchemyTier, rpcUrlFor } from '../chain/rpc'

// ─────────────────────────────────────────────────────────────────────────────
// TOKEN DISCOVERY — finding what a wallet holds that NOBODY PUT ON A LIST.
//
// the owner, 2026-08-06 12:58: "we need to be so good at detecting new assets…
// there are so many new tokens launching, a lot of these wallets you genuinely
// have no clue what's being added where. It's so hard to track how much money
// you've spent when you're buying all of these low caps… I'm sure with the
// Alchemy RPC key we can pick up some of this new stuff, and DexScreener as
// well… then we can literally be one of the best low-cap risk detectors."
//
// THE HOLE THIS FILLS. Until now the sweep asked `balanceOf` for every token on
// the CURATED VERIFIED LIST, per chain. That is a fine way to price the things
// we already know about and a structurally perfect way to MISS a token that
// launched this morning — the exact asset his users care most about. No amount
// of polling fixes it: the list simply does not contain the token, so the
// portfolio could never see it, however often it looked.
//
// HOW. One `alchemy_getTokenBalances` call per chain returns every ERC-20 the
// address holds, list or no list. Symbols and decimals then come from the chain
// itself (a multicall the transport coalesces), so a token needs no registry
// entry anywhere to show up in someone's book.
//
// WHAT THIS DELIBERATELY DOES NOT DO:
//   · NO POLLING. One call per chain per load, on the same query the sweep
//     already runs. The idle posture measured in docs/allocator/RPC-AUDIT.md is
//     zero standing reads and this keeps it at zero — discovery rides the load,
//     it does not tick.
//   · NO TRUST. A discovered token is an on-chain fact about a balance and
//     NOTHING else. Its symbol is deployer-controlled text (safe-copy bounds
//     it), its identity is not verified, and it never becomes tradeable or
//     seedable by being found — it appears in the book, which is all he asked
//     for and all we can honestly offer.
//   · NO INVENTED VALUE. Discovery finds tokens; pricing stays exactly where it
//     was. A discovered token with no readable price is UNPRICED and visible,
//     never dropped and never guessed.
// ─────────────────────────────────────────────────────────────────────────────

/** The most discovered tokens we will take from one chain. A wallet that has
 *  been airdropped four thousand scam tokens must not turn a page load into
 *  four thousand metadata reads — and past this many, the book stops being
 *  something a human reads anyway. Sorted by raw balance is meaningless across
 *  different decimals, so the cut is by the order the provider returns (its own
 *  relevance ordering) and the truncation is REPORTED, never silent. */
export const DISCOVERY_CAP = 60

export interface DiscoveryResult {
  /** Lowercased contract addresses with a nonzero balance. */
  addresses: string[]
  /** True when the provider had more than DISCOVERY_CAP to give. */
  truncated: boolean
  /** False when discovery could not run at all (no Alchemy endpoint, or the
   *  call failed) — the caller then stands on the curated sweep alone and must
   *  NOT read the empty list as "this wallet holds nothing else". */
  ok: boolean
}

const EMPTY: DiscoveryResult = { addresses: [], truncated: false, ok: false }

/** Does this chain have an endpoint that speaks the Alchemy token API? */
export function canDiscover(chainId: number): boolean {
  return hasAlchemyTier(chainId) && /alchemy\.com/.test(rpcUrlFor(chainId))
}

/** The chain's Blockscout base URL, '' where its explorer isn't one. The
 *  second discovery rung (owner 2026-08-06 1603: "it's not detecting my
 *  surplus… we need to improve the system") — 4663 has NO Alchemy tier, so
 *  the Alchemy rung structurally never ran there and unlisted RH tokens were
 *  invisible by construction. Blockscout's token-balances API answers the
 *  same question for exactly those chains. */
function blockscoutBase(chainId: number): string {
  try {
    const ex = chainCfg(chainId).explorer
    if (ex.includes('blockscout')) return ex
  } catch {
    /* unconfigured chain — the public map below may still know it */
  }
  // PUBLIC Blockscout instances for chains whose configured explorer is
  // Etherscan-family (owner 2026-08-06 16:5x: FWA + PRISM on MAINNET were
  // invisible on a keyless box — no Alchemy key means the Alchemy rung is
  // off, and chain 1's explorer is Etherscan, so discovery had NO rung at
  // all there). Blockscout runs keyless CORS-open instances for both;
  // verified live before wiring (13 mainnet / 17 Base rows for a real book).
  // Alchemy stays the primary where a key exists — this is the floor.
  return BLOCKSCOUT_PUBLIC[chainId] ?? ''
}

const BLOCKSCOUT_PUBLIC: Record<number, string> = {
  1: 'https://eth.blockscout.com',
  8453: 'https://base.blockscout.com',
}

/** The chain's DexScreener path segment, '' where it is not indexed. */
export function dexscreenerSlugFor(chainId: number): string {
  try {
    return chainCfg(chainId).dexscreenerSlug
  } catch {
    return ''
  }
}

/**
 * Every ERC-20 this address holds on this chain, whether or not anyone listed
 * it. Returns `ok: false` rather than throwing — a discovery that cannot run is
 * a smaller book, not a broken page, and the curated sweep still stands.
 */
export async function discoverHeldTokens(owner: Address, chainId: number): Promise<DiscoveryResult> {
  if (!canDiscover(chainId)) return discoverViaBlockscout(owner, chainId)
  // Keyed boxes ride Alchemy on every chain it serves (all three — rpc.ts
  // maps robinhood-mainnet too). Blockscout is the FALLBACK for a FAILED
  // Alchemy call as well as a missing key (hardening round 1.1, owner
  // pushback 2026-08-06 17:0x): a transient 4xx/5xx used to return EMPTY
  // and detection silently vanished on exactly the boxes with the best
  // setup.
  const viaAlchemy = await discoverViaAlchemy(owner, chainId)
  return viaAlchemy.ok ? viaAlchemy : discoverViaBlockscout(owner, chainId)
}

async function discoverViaAlchemy(owner: Address, chainId: number): Promise<DiscoveryResult> {
  try {
    const res = await fetch(rpcUrlFor(chainId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method: 'alchemy_getTokenBalances',
        params: [owner, 'erc20'],
      }),
    })
    if (!res.ok) return EMPTY
    const body = (await res.json()) as {
      result?: { tokenBalances?: { contractAddress?: string; tokenBalance?: string; error?: unknown }[] }
    }
    const rows = body.result?.tokenBalances
    if (!Array.isArray(rows)) return EMPTY
    const held: string[] = []
    for (const r of rows) {
      // A row carrying an error is UNREADABLE, not empty — skip it rather than
      // treat a failed read as a zero balance (the read-failed law).
      if (r.error != null) continue
      const addr = typeof r.contractAddress === 'string' ? r.contractAddress.toLowerCase() : null
      if (!addr || !/^0x[0-9a-f]{40}$/.test(addr)) continue
      if (!isNonzeroHex(r.tokenBalance)) continue
      held.push(addr)
    }
    const unique = [...new Set(held)]
    return { addresses: unique.slice(0, DISCOVERY_CAP), truncated: unique.length > DISCOVERY_CAP, ok: true }
  } catch {
    return EMPTY
  }
}

/** The Blockscout rung: /api/v2/addresses/{owner}/token-balances lists every
 *  token the explorer's own indexer has seen the address hold — verified live
 *  against 4663 (92 rows for a real book, 2026-08-06). Same contract as the
 *  Alchemy rung: a failure is ok:false (a smaller book, never a broken page),
 *  an error-carrying row is skipped, and the cap + truncated flag hold. */
async function discoverViaBlockscout(owner: Address, chainId: number): Promise<DiscoveryResult> {
  const base = blockscoutBase(chainId)
  if (!base) return EMPTY
  try {
    const res = await fetch(`${base}/api/v2/addresses/${owner}/token-balances`, {
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return EMPTY
    const body = (await res.json()) as
      | { items?: BlockscoutBalanceRow[] }
      | BlockscoutBalanceRow[]
    const rows = Array.isArray(body) ? body : (body.items ?? [])
    if (!Array.isArray(rows)) return EMPTY
    const held: string[] = []
    for (const r of rows) {
      const t = r?.token
      // ERC-20 only (NFT rows carry their own types); a missing/zero value is
      // not a holding; a malformed address never joins the sweep.
      if (t?.type && t.type !== 'ERC-20') continue
      const addr = (t?.address_hash ?? t?.address ?? '').toLowerCase()
      if (!/^0x[0-9a-f]{40}$/.test(addr)) continue
      const v = r?.value
      if (typeof v !== 'string' || !/^[0-9]+$/.test(v) || !/[1-9]/.test(v)) continue
      held.push(addr)
    }
    const unique = [...new Set(held)]
    return { addresses: unique.slice(0, DISCOVERY_CAP), truncated: unique.length > DISCOVERY_CAP, ok: true }
  } catch {
    return EMPTY
  }
}

interface BlockscoutBalanceRow {
  token?: { address?: string; address_hash?: string; type?: string }
  value?: string
}

/** A hex balance string that is present, parseable and above zero. Anything
 *  else (absent, malformed, "0x0", all-zero padding) is not a holding. */
function isNonzeroHex(v: string | undefined): boolean {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]*$/.test(v) || v.length <= 2) return false
  return /[1-9a-fA-F]/.test(v.slice(2))
}

export interface DiscoveredToken {
  address: string
  symbol: string
  decimals: number
}

/**
 * Symbol and decimals for discovered addresses, straight from the contracts —
 * the step that lets an unlisted token render as itself. Reads are concurrent
 * so the transport coalesces them into multicall.
 *
 * A token whose metadata will not read is DROPPED, and this is the one place
 * dropping is right: without decimals we cannot state an amount, and without a
 * symbol we cannot name it, so anything we rendered would be invented. The
 * curated list, whose entries carry both, is unaffected.
 */
export async function describeTokens(chainId: number, addresses: readonly string[]): Promise<DiscoveredToken[]> {
  if (addresses.length === 0) return []
  const client = clientFor(chainId)
  const out = await Promise.all(
    addresses.map(async (address) => {
      try {
        const [symbol, decimals] = await Promise.all([
          client.readContract({ address: address as Address, abi: erc20Abi, functionName: 'symbol' }) as Promise<string>,
          client.readContract({ address: address as Address, abi: erc20Abi, functionName: 'decimals' }) as Promise<number>,
        ])
        if (typeof symbol !== 'string' || symbol.length === 0) return null
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null
        // symbol() is attacker-typed: bound it AT THE SOURCE (controls, bidi
        // overrides and zero-widths stripped; 24-char clip — the shown-text-
        // is-a-money-surface law), so no downstream surface renders a 5,000-
        // char wall or an invisible-character impersonation.
        const bounded = symbol
          .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\ufeff\u202a-\u202e\u2066-\u2069]/g, '')
          .trim()
          .slice(0, 24)
        if (bounded.length === 0) return null
        return { address: address.toLowerCase(), symbol: bounded, decimals } satisfies DiscoveredToken
      } catch {
        return null
      }
    }),
  )
  return out.filter((t): t is DiscoveredToken => t != null)
}

/**
 * USD unit prices for discovered tokens, in DexScreener batches.
 *
 * WHY NOT THE POOL ENGINE, which prices everything else here: it costs a
 * detection per token, and discovery can hand us sixty. Sixty pool detections
 * per chain per page load is precisely the kind of growth the budget in
 * docs/allocator/RPC-AUDIT.md exists to prevent — and it would buy nothing,
 * because these are exactly the tokens DexScreener is best at. It is also what
 * the owner described in the same breath as the Alchemy key ("and DexScreener as
 * well"). One keyless HTTP call per 30 tokens, zero RPC.
 *
 * A chain DexScreener does not index (Robinhood) yields nothing, and the
 * holdings stay UNPRICED and visible — the honest state, never a zero.
 */
export async function priceDiscovered(slug: string, addresses: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (!slug || addresses.length === 0) return out
  const list = [...new Set(addresses.map((a) => a.toLowerCase()))]
  for (let i = 0; i < list.length; i += 30) {
    const batch = list.slice(i, i + 30)
    try {
      const res = await fetch(`https://api.dexscreener.com/tokens/v1/${slug}/${batch.join(',')}`, {
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) continue // a failed batch is unpriced, never zero
      const pairs = (await res.json()) as {
        baseToken?: { address?: string }
        priceUsd?: string | number
        liquidity?: { usd?: number }
      }[]
      // The DEEPEST pool's print wins: a shallow pool's price is noise, and on
      // a brand-new token there is usually one real market and several ghosts.
      // Below the floor, even the deepest pool is not a market: airdropped
      // scam tokens carry self-made ghost pools printing absurd numbers (live
      // repro 2026-08-12 — one such print valued a wallet at $620 TRILLION on
      // Robinhood Chain). Under it the holding stays UNPRICED and visible,
      // the honest state this module already promises; a genuinely-traded new
      // token crosses $1k of liquidity in its first hours.
      // …and a seeded-just-over-the-floor ghost still fails the ACTIVITY bar:
      // a real market trades; a stage does not (the owner 2026-08-18, the
      // airdrop that beat the old floor).
      const MIN_POOL_LIQUIDITY_USD = 2_500
      const MIN_POOL_VOLUME_24H_USD = 50
      const best = new Map<string, { liq: number; price: number }>()
      for (const p of Array.isArray(pairs) ? pairs : []) {
        const addr = p.baseToken?.address?.toLowerCase()
        if (!addr) continue
        const price = typeof p.priceUsd === 'string' ? Number(p.priceUsd) : p.priceUsd
        if (price == null || !Number.isFinite(price) || price <= 0) continue
        const liq = p.liquidity?.usd ?? 0
        if (liq < MIN_POOL_LIQUIDITY_USD) continue
        const vol24 = (p as { volume?: { h24?: number } }).volume?.h24 ?? 0
        if (!(vol24 >= MIN_POOL_VOLUME_24H_USD)) continue
        if (liq >= (best.get(addr)?.liq ?? -1)) best.set(addr, { liq, price })
      }
      for (const [addr, v] of best) out.set(addr, v.price)
    } catch {
      /* offline or rate-limited — this batch stays unpriced */
    }
  }
  return out
}
