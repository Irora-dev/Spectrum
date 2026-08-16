import { erc20Abi, isAddress, parseAbi, type Address, type PublicClient } from 'viem'
import { COW_VAULT_RELAYER } from './cow'
import { deploymentFor } from '../chain/deployments'
import { LIFI_TARGETS } from './lifi'
import { PERMIT2_ADDRESS } from './permit2'

// ─────────────────────────────────────────────────────────────────────────────
// THE APPROVALS LEDGER (the owner ~21:5x: "any safeguards we can help users with?
// maybe a revoke system on the portfolio") — what is STANDING on-chain for the
// tokens you hold, against the spenders this product knows, with the honest
// scope stated: this is not a chain-wide approval scanner (that takes a log
// index we don't run); it is your held tokens × the named spender registry,
// which covers everything THIS product would ever ask you to sign plus the
// canonical infrastructure beside it. Every row is a live read; a revoke is
// approve(0) / Permit2's own zeroing — standard, moves no funds.
//
// Display law (the depeg lesson): NO fixture rows, ever — a fake standing
// approval is an alarming lie. The panel self-hides when nothing stands.
// ─────────────────────────────────────────────────────────────────────────────

export interface KnownSpender {
  address: Address
  label: string
  /** What it exists for — the row's plain-words identity. */
  role: string
}

/** The spender registry, per chain. The batcher joins at ceremony seating
 *  (deploymentFor carries it then) — a registry row, not a code change. */
export function knownSpenders(chainId: number): KnownSpender[] {
  const out: KnownSpender[] = [
    { address: PERMIT2_ADDRESS, label: 'Permit2', role: 'Uniswap’s canonical permit contract' },
  ]
  try {
    const router = deploymentFor(chainId).swapRouter
    if (router) out.push({ address: router, label: 'Spectrum router', role: 'basket buys & sells' })
  } catch {
    /* unconfigured chain: no router row */
  }
  if (chainId === 1 || chainId === 8453) {
    out.push({ address: COW_VAULT_RELAYER, label: 'CoW vault relayer', role: 'settles limit orders' })
  }
  // single-sourced from the seam that signs against them (battle-test note):
  // a local copy here could drift at a diamond migration, leaving a standing
  // LiFi approval invisible in the ledger that exists to reveal it
  const lifi = LIFI_TARGETS[chainId]
  if (lifi) out.push({ address: lifi as Address, label: 'LI.FI', role: 'bridging router' })
  return out
}

export interface StandingApproval {
  chainId: number
  token: Address
  symbol: string
  spender: KnownSpender
  /** The raw allowance; 2^256-1-ish reads as infinite. */
  amountRaw: bigint
  infinite: boolean
  /** Permit2 AllowanceTransfer grants expire; ERC-20 ones never do. */
  expiresAt?: number
  via: 'erc20' | 'permit2'
}

const INFINITE_FLOOR = 2n ** 255n

const permit2Abi = parseAbi([
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
])

export { permit2Abi }

/** Whether Permit2 is DEPLOYED on a chain — probed once (bytecode at the
 *  canonical address), cached per chain for the session. The distinction is
 *  the honest-failure law's hinge (battle-test half-2 finding 3): where
 *  Permit2 exists, a failed allowance read must COUNT as unchecked — a
 *  rate-limited read is indistinguishable from absence, and swallowing it
 *  showed a complete-looking ledger while a live sub-grant stood. Where it
 *  genuinely does not exist (4663 until contracts say otherwise), skipping
 *  is correct and counting would cry wolf on every row. An UNREADABLE probe
 *  returns null and the caller counts the layer unchecked (unknown ≠ absent). */
const permit2Presence = new Map<number, boolean>()
export async function permit2DeployedOn(client: PublicClient, chainId: number): Promise<boolean | null> {
  const cached = permit2Presence.get(chainId)
  if (cached !== undefined) return cached
  try {
    const code = await client.getCode({ address: PERMIT2_ADDRESS })
    const deployed = code != null && code !== '0x'
    permit2Presence.set(chainId, deployed)
    return deployed
  } catch {
    return null // probe failed: unknown, NOT absent — never cache a failure
  }
}

/** Test seam. */
export function __resetPermit2PresenceForTests(): void {
  permit2Presence.clear()
}

/** Read what stands for one wallet's held tokens on one chain. Failed reads
 *  are SKIPPED (a read that failed is not a verdict — never render a row off
 *  an error, and never claim "nothing standing" off one either: the caller
 *  gets `failed` counted so the panel can say "N couldn't be checked"). */
export async function readStandingApprovals(
  client: PublicClient,
  chainId: number,
  owner: Address,
  held: { token: Address; symbol: string }[],
  nowSec: number,
): Promise<{ rows: StandingApproval[]; failed: number }> {
  const spenders = knownSpenders(chainId)
  const rows: StandingApproval[] = []
  let failed = 0
  // ONE presence probe decides how Permit2-leg errors count (finding 3):
  // deployed → a failed read is UNCHECKED (counted); absent → skipping is
  // honest; probe unreadable → the whole layer counts unchecked ONCE (we
  // cannot tell absence from outage, and "unknown" must never read as clean).
  const p2Deployed = await permit2DeployedOn(client, chainId)
  if (p2Deployed == null) failed++
  await Promise.all(
    held.flatMap((h) =>
      spenders.map(async (sp) => {
        try {
          const amount = await client.readContract({
            address: h.token,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [owner, sp.address],
          })
          if (amount > 0n)
            rows.push({
              chainId,
              token: h.token,
              symbol: h.symbol,
              spender: sp,
              amountRaw: amount,
              infinite: amount >= INFINITE_FLOOR,
              via: 'erc20',
            })
        } catch {
          failed++
        }
        // Permit2's OWN sub-grants (AllowanceTransfer): other apps leave these
        // standing; they expire, but until then they spend. Same spender set.
        if (sp.address !== PERMIT2_ADDRESS && p2Deployed === true) {
          try {
            const [amt, expiration] = await client.readContract({
              address: PERMIT2_ADDRESS,
              abi: permit2Abi,
              functionName: 'allowance',
              args: [owner, h.token, sp.address],
            })
            if (amt > 0n && expiration > nowSec)
              rows.push({
                chainId,
                token: h.token,
                symbol: h.symbol,
                spender: sp,
                amountRaw: amt,
                infinite: amt >= 2n ** 159n,
                expiresAt: Number(expiration),
                via: 'permit2',
              })
          } catch {
            // Permit2 IS deployed here, so this failed read is a real hole
            // in the ledger — count it; the panel's footer says "N couldn't
            // be checked" instead of showing a complete-looking all-clear
            failed++
          }
        }
      }),
    ),
  )
  rows.sort((a, b) => (b.infinite ? 1 : 0) - (a.infinite ? 1 : 0) || a.symbol.localeCompare(b.symbol))
  return { rows, failed }
}

// ── the zero-balance memory (finding 5): a leg sold to zero drops out of the
//    held-scoped read, so a leftover approval from an abandoned run went
//    invisible while remaining spendable. Remember every token that ever
//    produced an approval row (per owner+chain, capped) and keep reading it. ──

const WATCH_KEY = 'spectrum:approval-watch:v1'
const WATCH_CAP = 64

type WatchMap = Record<string, { token: Address; symbol: string }[]>

function readWatch(): WatchMap {
  try {
    const raw = window.localStorage.getItem(WATCH_KEY)
    const parsed = raw ? (JSON.parse(raw) as WatchMap) : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

const watchKey = (owner: Address, chainId: number) => `${chainId}:${owner.toLowerCase()}`

/** Called with each read's rows: any token that ever showed an approval is
 *  remembered, so a later read still watches it at zero balance. */
export function rememberApprovalTokens(owner: Address, chainId: number, rows: StandingApproval[]): void {
  if (rows.length === 0) return
  try {
    const all = readWatch()
    const k = watchKey(owner, chainId)
    const have = new Map((all[k] ?? []).map((t) => [t.token.toLowerCase(), t]))
    for (const r of rows) if (!have.has(r.token.toLowerCase())) have.set(r.token.toLowerCase(), { token: r.token, symbol: r.symbol })
    all[k] = [...have.values()].slice(-WATCH_CAP)
    window.localStorage.setItem(WATCH_KEY, JSON.stringify(all))
  } catch {
    /* private browsing: the memory just does not persist */
  }
}

/** The tokens a read must include beyond what the wallet currently holds —
 *  sanitized on read like every storage seam. */
export function watchedApprovalTokens(owner: Address, chainId: number): { token: Address; symbol: string }[] {
  const rows = readWatch()[watchKey(owner, chainId)] ?? []
  return rows.filter(
    (t) => t && typeof t.token === 'string' && isAddress(t.token) && typeof t.symbol === 'string' && t.symbol.length > 0 && t.symbol.length <= 24,
  )
}

/** The revoke calls — standard, fund-free. ERC-20: approve(spender, 0).
 *  Permit2 sub-grant: approve(token, spender, 0, 0) ON Permit2. */
export function revokeCall(row: StandingApproval) {
  if (row.via === 'erc20') {
    return { address: row.token, abi: erc20Abi, functionName: 'approve' as const, args: [row.spender.address, 0n] as const }
  }
  return {
    address: PERMIT2_ADDRESS,
    abi: permit2Abi,
    functionName: 'approve' as const,
    args: [row.token, row.spender.address, 0n, 0] as const,
  }
}
