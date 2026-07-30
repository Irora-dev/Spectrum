import { getAddress, parseAbi, parseAbiItem, parseEventLogs, type Address, type PublicClient } from 'viem'

// ─────────────────────────────────────────────────────────────────────────────
// Creator league — FE seam over the ownerless LeaguePool (graduated to
// spectrum-contracts v3/lineage 2026-07-29: src/registry/LeaguePool.sol).
//
// Mechanism the UI renders — A LIVE STREAM TO THE CROWN-HOLDER (contract rebuild
// f71ef4b, 2026-07-30). There is NO prize pot, NO season-end settlement and NO
// claim window. Every basket skims a league slice off each fee and cranks it
// here; whoever holds the crown WHEN A SLICE ARRIVES is entitled to it
// immediately, and can withdraw at any time.
//
// The three facts copy must not blur (getting the middle one wrong would be
// actively misleading, per the contracts audit):
//   · SCORE — creatorFees[season][creator], raw settlement, counted LINEARLY.
//   · SEASONS ARE THE SCORING WINDOW ONLY. Scores reset every 30 days; the
//     CROWN PERSISTS across the boundary. So the countdown means "scores reset
//     in N days", NEVER "payout in N days" — there is no payout event at all.
//   · OWED — `owed(creator)` is money ALREADY THEIRS, withdrawable now. It is a
//     real balance, not a projection (unlike the old claimable(), which was 0
//     for everyone but the season's winner).
//
// Delivery is deliberately a PULL: credit() never transfers. USDG has
// per-address freeze powers, so a push would let ONE frozen champion revert
// every basket's league flush chain-wide with no admin to clear it. The
// champion calls withdraw() — there is no auto-payout and there must not be.
//
// This supersedes TWO earlier models whose ABIs are gone (calls revert): the
// √-weighted pro-rata pool (weightOf/totalWeight) and the seasonal
// winner-take-all pot (poolOf/claimable/claim/podium/rankBps/currentEpoch).
//
// NOT WASH-PROOF, and copy must not say so: streaming removed the snipe-the-pot
// exposure, but a season boundary still zeroes every score while the crown
// persists, so one wei can flip the crown at the boundary (audit W-2, open with
// R/Colby). The leaderboard is honest — raw fees, linear — but "fair" and
// "wash-proof" are not backed today.
//
// Honesty seam (audit H5): logs are used ONLY to discover the roster (you
// cannot enumerate a mapping); every number shown — credited, weight, the
// share denominator, the pool — is read from contract state. A truncated log
// window (rate-limited RPC) can therefore hide a ROW, but can never inflate
// anyone's share; `rosterComplete` says which of those worlds you are in.
//
// The pool address ships per-chain in deployments.json (`leaguePool`,
// optional). No address → the league surfaces don't exist on that site.
// ─────────────────────────────────────────────────────────────────────────────

export const leaguePoolAbi = parseAbi([
  'function currentSeason() view returns (uint256)',
  'function seasonEndsAt(uint256 season) pure returns (uint256)',
  'function EPOCH_SECONDS() view returns (uint256)',
  'function champion() view returns (address)',
  'function owed(address) view returns (uint256)',
  'function totalOwed() view returns (uint256)',
  'function scoreToBeat() view returns (uint256)',
  'function totalFees(uint256) view returns (uint256)',
  'function creatorFees(uint256, address) view returns (uint256)',
  'function withdraw() returns (uint256)',
  'function withdrawTo(address to) returns (uint256)',
  // `to` is NEW and load-bearing: it is the address the flow actually went to
  // (the crown-holder at arrival), which is not necessarily `creator`.
  'event Credited(uint256 indexed season, address indexed creator, address indexed source, address to, uint256 amount)',
  'event CrownTaken(uint256 indexed season, address indexed from, address indexed to, uint256 score)',
  'event Withdrawn(address indexed creator, address indexed to, uint256 amount)',
])
const creditedEvent = parseAbiItem(
  'event Credited(uint256 indexed season, address indexed creator, address indexed source, address to, uint256 amount)',
)

export interface LeagueStanding {
  creator: Address
  /** This season's SCORE: settlement raw (6dp) their baskets generated, LINEAR. */
  credited: bigint
  /** 0-indexed position on the leaderboard by score. */
  rank: number
  /** True for the actual on-chain `champion` — the crown-holder taking the flow
   *  right now. Read from the contract, NOT inferred from rank: the crown
   *  persists across a season boundary, so at the start of a season the
   *  incumbent can hold the crown while every score (theirs included) is 0. */
  leader: boolean
  /** How much MORE score this creator needs to take the crown (0 if they hold
   *  it). Derived from `scoreToBeat`, which is the champion's current score. */
  toBeat: bigint
}

export interface LeagueSnapshot {
  season: number
  /** Unix seconds when SCORES RESET (not a payout — there is no payout event). */
  scoresResetAt: number
  /** The current crown-holder, or null when nobody has ever held it. */
  champion: Address | null
  /** The champion's score — what a challenger must strictly exceed. The honest
   *  headline number, in place of the pot size the old model had. */
  scoreToBeat: bigint
  /** What the champion can withdraw right now: already theirs, not a forecast. */
  championOwed: bigint
  /** The pool's whole liability across all creators (solvency read). */
  totalOwed: bigint
  /** Σ scores this season (contract totalFees) — informational only. */
  total: bigint
  /** False when the roster came from a truncated log window (rate-limited
   *  RPC): rows may be missing, but every shown share is still exact. */
  rosterComplete: boolean
  /** True when EVERY log window failed — we know nothing about who is on the
   *  board. "No fees credited yet" would be a lie in this state (audit
   *  2026-07-29): the page must say the read failed, not that nobody raced. */
  rosterFailed: boolean
  standings: LeagueStanding[]
}

/** Pure: contract-read rows → the leaderboard, ordered LINEARLY on score.
 *  `champion` and `scoreToBeat` come from the CONTRACT, never inferred from the
 *  rows: the crown persists across a season reset, so the incumbent can be
 *  champion while every score on the board (including theirs) is 0 — inferring
 *  the crown from rank would hand it to the wrong creator for a whole season's
 *  opening. A truncated roster can only omit a row; it moves no money. */
export function buildStandings(
  rows: { creator: Address; credited: bigint }[],
  champion: Address | null,
  scoreToBeat: bigint,
): LeagueStanding[] {
  const byCreator = new Map<string, bigint>()
  for (const r of rows) byCreator.set(r.creator.toLowerCase(), r.credited)
  const champLower = champion?.toLowerCase() ?? null
  // The champion belongs on the board even with no score yet this season.
  if (champLower && !byCreator.has(champLower)) byCreator.set(champLower, 0n)
  const sorted = [...byCreator.entries()].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
  return sorted.map(([creator, credited], i) => ({
    creator: getAddress(creator),
    credited,
    rank: i,
    leader: creator === champLower,
    // strictly exceed: matching the champion's score does not take the crown
    toBeat: creator === champLower || credited > scoreToBeat ? 0n : scoreToBeat - credited + 1n,
  }))
}

/**
 * The live snapshot: current season, the score-reset countdown, the crown and
 * the flow it is taking. Credited events (season = the FIRST indexed topic, one
 * bounded log query) discover WHO is on the board; champion/scoreToBeat/owed/
 * creatorFees supply every number (the batching client folds the per-creator
 * reads into ~one multicall). Client is a parameter so the whole path tests
 * against anvil.
 */
export async function fetchLeagueSnapshot(
  client: PublicClient,
  pool: Address,
  fromBlock: bigint = 0n,
): Promise<LeagueSnapshot> {
  const [epoch, epochSeconds] = await Promise.all([
    client.readContract({ address: pool, abi: leaguePoolAbi, functionName: 'currentSeason' }),
    client.readContract({ address: pool, abi: leaguePoolAbi, functionName: 'EPOCH_SECONDS' }),
  ])
  const [championRaw, scoreToBeatRaw, totalOwedRaw, totalFeesRaw, latest] = await Promise.all([
    client.readContract({ address: pool, abi: leaguePoolAbi, functionName: 'champion' }),
    client.readContract({ address: pool, abi: leaguePoolAbi, functionName: 'scoreToBeat' }),
    client.readContract({ address: pool, abi: leaguePoolAbi, functionName: 'totalOwed' }),
    client.readContract({ address: pool, abi: leaguePoolAbi, functionName: 'totalFees', args: [epoch] }),
    client.getBlockNumber({ cacheTime: 0 }),
  ])
  const zero = '0x0000000000000000000000000000000000000000'
  const champion = championRaw && championRaw !== zero ? (championRaw as Address) : null
  const championOwed = champion
    ? await client.readContract({ address: pool, abi: leaguePoolAbi, functionName: 'owed', args: [champion] })
    : 0n

  // Roster discovery. The full range is attempted first; the 500k-block retreat
  // exists for rate-limited RPCs and is marked incomplete — it must never be
  // treated as the season (a 30-day season far outruns 500k blocks on a fast L2).
  let creators: Address[] = []
  let rosterComplete = false
  let rosterFailed = true
  const windows: { from: bigint; to: bigint; complete: boolean }[] = [
    { from: fromBlock, to: latest, complete: true },
    { from: latest > 500_000n ? latest - 500_000n : 0n, to: latest, complete: false },
  ]
  for (const w of windows) {
    try {
      const logs = await client.getLogs({
        address: pool,
        event: creditedEvent,
        args: { season: epoch },
        fromBlock: w.from,
        toBlock: w.to,
      })
      const seen = new Set<string>()
      creators = parseEventLogs({ abi: leaguePoolAbi, logs })
        .filter((l) => l.eventName === 'Credited')
        .map((l) => (l.args as { creator: Address }).creator)
        .filter((c) => {
          const k = c.toLowerCase()
          if (seen.has(k)) return false
          seen.add(k)
          return true
        })
      rosterComplete = w.complete
      rosterFailed = false
      break
    } catch {
      /* range too wide for this RPC — retreat */
    }
  }

  // Every displayed number comes from contract state — one read per discovered
  // creator (concurrent → the client coalesces into a multicall). Ranking is
  // LINEAR on this number, so no second per-creator read is needed.
  const rows = await Promise.all(
    creators.map(async (creator) => ({
      creator,
      credited: await client.readContract({
        address: pool,
        abi: leaguePoolAbi,
        functionName: 'creatorFees',
        args: [epoch, creator],
      }),
    })),
  )

  return {
    season: Number(epoch),
    scoresResetAt: (Number(epoch) + 1) * Number(epochSeconds),
    champion,
    scoreToBeat: scoreToBeatRaw,
    championOwed,
    totalOwed: totalOwedRaw,
    total: totalFeesRaw,
    rosterComplete,
    rosterFailed,
    standings: buildStandings(rows, champion, scoreToBeatRaw),
  }
}

/** WHEN crown earnings can be taken, stated once so every surface agrees. There
 *  is no season wait and no claim window any more: flow credited to the crown is
 *  the holder's the moment it arrives, and withdraw() is callable at any time.
 *  Delivery is a PULL by design — see the header on why it must not auto-pay. */
export const CROWN_CLAIM_RULE =
  'League flow is yours the moment it arrives while you hold the crown — there is no season to wait for. Withdraw whenever you like; it keeps accruing until you do.'

/** What a creator can withdraw from the league pool right now (already theirs). */
export async function fetchOwed(client: PublicClient, pool: Address, creator: Address): Promise<bigint> {
  return client.readContract({ address: pool, abi: leaguePoolAbi, functionName: 'owed', args: [creator] })
}
