import { parseAbi, type Address } from 'viem'

// ─────────────────────────────────────────────────────────────────────────────
// PRISM v2 make-good airdrop — the claim vault + hook, Ethereum mainnet.
// The COMMUNITY launched this token; this module is a self-serve claim TOOL,
// not an operated surface (comms red line, R 2026-07-30: nothing may imply
// this site or Irora launches/operates/stewards the token).
//
// Contracts (deployed 2026-07-30, read back on-chain before this shipped:
// vault.token() == the hook, vault balance == the full 4454.677… PRISM
// reserve, claimed(largest holder) == false):
//   vault  — PrismMigration: claim(account, amount, proof) is PERMISSIONLESS
//            and always delivers to `account`; the caller only pays gas.
//            claimed(account) latches after delivery. NO SWEEP exists: what is
//            never claimed stays locked, which is why the community plan is
//            page-first THEN a push of whatever remains — this page must never
//            present itself as the only way holders get paid.
//   hook   — the PRISM v2 token itself. Fee-share NFTs mirror WHOLE tokens
//            (one per 1e18), minted at most 128 per transaction, so a claim of
//            more than 128 whole PRISM under-mints. syncNFTs(max) tops up for
//            msg.sender ONLY; max == 0 means "no caller limit" (the contract
//            still caps each call at 128) — 0 is the right argument, verified
//            in source: `if (max != 0 && want > max) want = max`.
// Snapshot: src/data/prism-claims.json (vendored verbatim from the public
// prismv2contracts repo, airdrop/claims.json) — 1203 addresses; the merkle
// root below is pinned against the file by a unit test AND matches the
// on-chain root. Keys in the file are EIP-55 checksummed; every lookup here
// normalizes to lowercase.
// ─────────────────────────────────────────────────────────────────────────────

// Typed `number`, not the literal 1: the wagmi config registers chains as
// Chain[] (ids: number), and a literal chainId makes SelectChains Extract to
// `never`, collapsing every mutation overload (same trap BasketBuilder pins).
export const PRISM_CLAIM_CHAIN_ID: number = 1

export const PRISM_CLAIM_VAULT: Address = '0xdF0A7EC235Fb104E5B3e7426DA7709186A809d47'
export const PRISM_V2_HOOK: Address = '0xCf4d29f14Cc585DDd1167F956092852AF844e040'
/** The snapshot tree root — pinned so a swapped data file fails loudly in tests. */
export const PRISM_CLAIM_ROOT = '0x2cd60218d3f802a855996dbcbf7db5db860f88c541468c7601e02e627d33e12f'

export const prismVaultAbi = parseAbi([
  'function claim(address account, uint256 amount, bytes32[] proof)',
  'function claimed(address account) view returns (bool)',
])

export const prismHookAbi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function nftBalanceOf(address owner) view returns (uint256)',
  'function syncNFTs(uint256 max)',
])

export interface PrismClaim {
  /** The snapshot allocation in wei (1e18 = one whole PRISM). */
  amount: bigint
  proof: `0x${string}`[]
}

// Both data files load lazily (dynamic import → their own chunks) so neither
// the 1.1MB proofs file nor the 53KB index rides in the main bundle. Cached
// after first load.
let indexPromise: Promise<Set<string>> | null = null
let claimsPromise: Promise<Map<string, PrismClaim>> | null = null

/** Is `address` in the snapshot? Backed by the 53KB address index — safe to
 *  call from the site-wide banner. */
export async function isInClaimSnapshot(address: string): Promise<boolean> {
  indexPromise ??= import('../../data/prism-claim-index.json').then(
    (m) => new Set(m.default as string[]),
  )
  return (await indexPromise).has(address.toLowerCase())
}

/** The full claim row for `address` (amount + proof), or null when the address
 *  isn't in the snapshot. Loads the 1.1MB proofs chunk — /claim page only. */
export async function lookupClaim(address: string): Promise<PrismClaim | null> {
  claimsPromise ??= import('../../data/prism-claims.json').then((m) => {
    const rows = (m.default as { claims: Record<string, { amount: string; proof: string[] }> }).claims
    const map = new Map<string, PrismClaim>()
    for (const [addr, row] of Object.entries(rows)) {
      map.set(addr.toLowerCase(), { amount: BigInt(row.amount), proof: row.proof as `0x${string}`[] })
    }
    return map
  })
  return (await claimsPromise).get(address.toLowerCase()) ?? null
}

/** How many fee-share NFTs `owner` is short of their whole-token count —
 *  exactly the gap syncNFTs(0) closes (≤128 per press). 0 = fully mirrored.
 *  Mirrors the hook's own math: target = balanceOf / 1e18 (floor). */
export function syncGap(balance: bigint, nftCount: bigint): bigint {
  const target = balance / 10n ** 18n
  return target > nftCount ? target - nftCount : 0n
}

/** Whole-token count for display (fee shares accrue per WHOLE token — a
 *  sub-1-PRISM allocation mints nothing and earns nothing from the fee layer). */
export function wholeTokens(amount: bigint): bigint {
  return amount / 10n ** 18n
}
