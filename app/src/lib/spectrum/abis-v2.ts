import { parseAbi, parseAbiItem } from 'viem'

// ─────────────────────────────────────────────────────────────────────────────
// This is the SINGLE integration point between the FE and the Spectrum V2
// contracts. The SEMANTICS encoded here are requirements: if the contracts cannot
// provide a view with these semantics, surface that — do not silently absorb it.
//
// V2 truths encoded here (vs v1):
//   • Settlement asset is canonical Base USDC. dStable appears nowhere.
//   • Fee config is per-basket and immutable: the creator picks `basketFeeBps`
//     (bounded by [MIN,MAX]_BASKET_FEE_BPS) + a single capped, removable
//     `creatorShareBps` (≤ MAX_CREATOR_SHARE_BPS = 30% of the remainder) paid to
//     `creatorPayout`. The PRISM burn (10%), interface (≈5%) and launcher (≈5%)
//     shares are FIXED protocol constants, identical on every basket — see
//     fee-model.ts. The `launcher` is a per-basket origination recipient injected
//     by whoever deploys the kit (operator config), never a creator dial. Holders
//     are GUARANTEED ≥ 70% of the remainder (the cap is the floor; no setter).
//     There is NO per-basket burn share, NO ratchet, NO creator-set routing table.
//   • NAV is statically readable: exchangeRate()/totalReserve() are
//     non-reverting (value, fullyPriced) display-grade marks.
//   • Mint/redeem require non-empty hookData with per-leg minimums —
//     see hook-data.ts; the FE has NO zero/empty legMins path.
//   • redeemInKind(amount, legMask, to) is the unconditional exit:
//     constituents-out only, never touches USDC/pools; the bool[] legMask lets
//     the caller explicitly skip a frozen/reverting leg (masked legs' pro-rata
//     stays in reserve for remaining holders). Deterministic pro-rata, no
//     minOuts.
//   • The factory enumerates baskets (allBaskets/allBasketsLength),
//     so a keyless public-RPC build can list everything without log scans.
//   • Deploys are priced by a Dutch auction; there is NO
//     deployEnabled() view in V2 — do not re-add one.
// ─────────────────────────────────────────────────────────────────────────────

// Hook permission bits the mined token address must carry: BEFORE_SWAP (0x80) |
// BEFORE_SWAP_RETURNS_DELTA (0x08). Unchanged from v1 — what forces re-mining
// every salt is the new init-code hash, not the flags. Single source of truth
// for the miner (salt-mining.ts).
export const HOOK_FLAGS_SUFFIX = 0x88n
export const HOOK_FLAGS_MASK = 0x3fffn

// One basket entry as the V2 factory expects it. DRAFT: shape carried over from
// the deployed v1 factory minus the dstable-era assumptions; the V2 contracts
// deliverable owns the final tuple. There is exactly ONE target factory — no
// live-v1 / fork hedging.
const BASKET_ENTRY =
  '(address asset, uint8 venue, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) ethPool, uint24 v3Fee, address v2Pair, uint16 weight, uint8 decimals)'

// The immutable fee config committed at deploy. CREATE2-committed: it is a
// salt-mining input and part of predictTokenAddress, so its FIELD ORDER must
// match the contract's FeeConfig struct EXACTLY — changing it invalidates every
// mined hook salt (the "re-salt"). Fee-model redesign: the burn/interface/
// launcher shares are fixed protocol constants (fee-model.ts); the tuple carries
// only the rate, the capped creator share, the creator payout, and the per-basket
// launcher (the old creator-set `routes[]` is gone).
const FEE_CONFIG =
  '(uint16 basketFeeBps, uint16 creatorShareBps, address creatorPayout, address launcher)'

export interface FeeConfigInput {
  /** Total fee in bps, within [MIN_BASKET_FEE_BPS, MAX_BASKET_FEE_BPS] (floor 100). */
  basketFeeBps: number
  /** Creator's share of the post-burn-interface-launcher remainder, in bps,
   *  within [0, MAX_CREATOR_SHARE_BPS = 3000]. 0 = no creator fee (removable).
   *  Holders take whatever is left ⇒ guaranteed ≥ 70% of the remainder. */
  creatorShareBps: number
  /** Recipient of the creator share. Must be non-zero iff creatorShareBps > 0
   *  (the contract reverts BadCreatorShare otherwise). Use the zero address when
   *  creatorShareBps is 0. */
  creatorPayout: `0x${string}`
  /** Per-basket launcher/origination recipient — injected by the deploying
   *  integrator (operator config), NEVER a creator dial. The zero address means
   *  no launcher (the fixed ~5% slice stays in the remainder → creator+holders). */
  launcher: `0x${string}`
}

// ── Basket token (ERC-20 that is its own V4 hook + LP) ──────────────────────
export const basketAbi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function basketLength() view returns (uint256)',
  `function basket(uint256) view returns ${BASKET_ENTRY}`,
  // NAV denominator (excludes tokens pending burn).
  'function effectiveSupply() view returns (uint256)',
  // Tracked reserve of a constituent (raw, asset decimals) — the donation-immune
  // `idleHeld` accounting getter, NOT raw balanceOf. Static-safe balances read.
  'function idleHeld(address asset) view returns (uint256)',
  // ── Static NAV views — non-reverting (value, priced) marks ──
  'function exchangeRate() view returns (uint256 rate1e18, bool fullyPriced)',
  'function totalReserve() view returns (uint256 usdcValue, bool fullyPriced)',
  'function quoteLeg(uint256 i) view returns (uint256 usdcValue, bool priced)',
  'function claimableFees(address holder) view returns (uint256)',
  // ── Mutable fee state (live, not the immutable config) — the /flush console ──
  // USDC backing settled holder accruals; pull-claimed via claimFees().
  'function feeReserve() view returns (uint256)',
  // Accrued burn-share USDC awaiting the permissionless flushPrismBurn() crank.
  'function pendingPrismBurn() view returns (uint256)',
  // Basket tokens queued in the ERC-6909 lazy-burn queue, settled by redeemClaims().
  'function pendingBasketBurn() view returns (uint256)',
  // Interface / launcher / creator pull accruals, keyed by recipient; flushed by
  // the permissionless flushFrontendFees(fe) crank (all three accrue together).
  'function pendingFrontendFees(address fe) view returns (uint256)',
  // ── Fee surfaces — bound by the /flush creator console ──
  // Holder pull-claim of accrued USDC (no bounty; a blocklisted holder blocks only
  // their own claim). Emits FeesClaimed.
  'function claimFees()',
  // Permissionless crank: sells pendingPrismBurn USDC → ETH and bridges to the L1
  // PrismBurner; pays the caller CRANK_BOUNTY_BPS. `minEthOut` is the caller's
  // slippage floor on the real swap (reverts SlippageExceeded below it); reverts
  // NothingToBurn (nothing pending) / BelowBridgeThreshold (spot value too small).
  'function flushPrismBurn(uint256 minEthOut)',
  // Permissionless crank: pushes pendingFrontendFees[fe] to `fe` (interface,
  // launcher, OR creator — all flush through here); pays the caller the bounty.
  // No-ops on zero; a failed push (e.g. blocklisted recipient) re-queues the amount.
  'function flushFrontendFees(address fe)',
  // Permissionless maintenance crank: settles the ERC-6909 lazy-burn queue (burns
  // pending basket-token claims). No bounty; no-op at zero. Keeps redemption
  // always reachable for a frozen leg. Emits ClaimsRedeemed.
  'function redeemClaims()',
  // ── Per-basket immutable fee config ── the creator picks the rate + a
  // capped, removable creator share paid to creatorPayout; the burn/interface/
  // launcher shares are fixed protocol constants (fee-model.ts), not per-basket
  // getters. There is no burnShareBps() in V2. `launcher` is the per-basket
  // origination recipient set once at deploy (address(0) = none). Holders are
  // guaranteed the rest of the remainder (≥70%), derived — not a getter.
  'function basketFeeBps() view returns (uint16)',
  'function creatorShareBps() view returns (uint16)',
  'function creatorPayout() view returns (address)',
  'function launcher() view returns (address)',
  // ── Unconditional exit: constituents-out only, pro-rata, no minOuts ──
  'function redeemInKind(uint256 amount, bool[] legMask, address to)',
  // ── In-kind mint ──
  // Deposit constituents in-kind, mint shares against live reserves; the FULL fee
  // is taken as a proportional in-kind slice, sold to USDC, and run through the
  // normal _distributeFee waterfall. `frontend` = the interface kickback tag
  // (address(0) → follows creator routing). The migrate modal drives this LIVE
  // behind TRADING_ENABLED (client-orchestrated redeemInKind → approvals →
  // mintInKind; see use-migrate.ts — there is no migration router periphery).
  // It is version-AGNOSTIC by design — no "old version" knowledge (no controller).
  'function mintInKind(uint256[] amounts, uint256 minShares, address to, address frontend) returns (uint256 shares)',
  // MintedInKind does NOT re-emit the per-leg amounts[] — they ride in the tx
  // calldata (the EIP-170 diet dropped them). Keep this 4-arg shape in lockstep with
  // SpectrumBasket.sol's event or in-kind mints will fail to decode.
  'event MintedInKind(address indexed to, address indexed frontend, uint256 shares, uint256 feeUsdc)',
  // ── Fee-surface events (parsed by the /flush console for tx confirmation) ──
  'event FeesClaimed(address indexed holder, uint256 amount)',
  'event FrontendFeesFlushed(address indexed frontend, uint256 amount)',
  'event PrismBurnBridged(uint256 usdcIn, uint256 ethBridged)',
  'event ClaimsRedeemed(uint256 claimsBurned)',
])

export const erc20BalanceAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
])

// ERC-20 allowance + EXACT-AMOUNT approve. The swap router pulls `tokenIn` (USDC
// on a buy, the basket token on a sell) via transferFrom, so the trader approves
// the router first. Exact-amount approvals only — no infinite approve (the swap
// design's standing-allowance red line). NET-NEW: before the swap wiring the FE
// had no approval surface at all (deploy is ETH-payable; the flush cranks need
// none).
export const erc20ApproveAbi = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
])

// V4 PoolManager storage reader (pool engine).
export const poolManagerAbi = parseAbi([
  'function extsload(bytes32 slot) view returns (bytes32)',
])

// ── Trading swap router ──
// A Spectrum basket is its OWN Uniswap V4 hook + LP: there is NO USDC buy/sell
// method on the basket itself (the only value-movers are mintInKind/redeemInKind
// + the cranks, above). Buy/sell is an external V4 PoolManager.swap into the
// basket's _beforeSwap, which HARD-REVERTS on empty hookData (MissingHookData) —
// so a generic aggregator can never route it (it would send empty hookData). The
// swap MUST carry the (minOut, legMins[], frontend) payload this FE encodes
// (hook-data.ts).
//
// The router is a single exact-input entrypoint that derives the basket's PoolKey
// from its on-chain selfKey(), runs the swap inside PoolManager.unlock, settles
// tokenIn from the payer / takes tokenOut, and forwards the FE's hookData VERBATIM.
// Whoever deploys the kit supplies the router address (or their own router); the
// address ships EMPTY (deployments.ts) and every call is hard-gated on
// SWAP_ENABLED, so this binds INERT until a router is configured.
//
//   tokenIn = USDC   → buy  (mint-via-swap):  amountIn USDC   → ≥ minOut shares
//   tokenIn = basket → sell (redeem-via-swap): amountIn shares → ≥ minOut USDC
// The router pulls tokenIn via transferFrom (caller approves the router first).
// `minOut` is the AGGREGATE out floor. On a BUY, per-leg protection rides in
// hookData.legMins (non-zero — encodeMintHookData refuses a zero payload, so each
// leg's swap is bounded end-to-end); on a SELL the binding protection IS minOut
// (the basket reverts SlippageExceeded below it) and legMins are length-correct
// zeros (encodeRedeemHookData). `to` is the recipient of tokenOut.
export const swapRouterAbi = parseAbi([
  'function swapExactIn(address basket, address tokenIn, uint256 amountIn, uint256 minOut, bytes hookData, address to) returns (uint256 amountOut)',
  'event Swapped(address indexed basket, address indexed trader, address tokenIn, uint256 amountIn, uint256 amountOut, address frontend)',
])

// ── Factory ──────────────────────────────────────────────────────────────────
export const factoryAbi = parseAbi([
  // Keyless enumeration: append-only public array — the
  // PRIMARY discovery path. Log scans are enrichment/fallback only.
  'function allBaskets(uint256) view returns (address)',
  'function allBasketsLength() view returns (uint256)',
  // Registry: deployed basket → creator (deployer). On-chain attribution fact.
  'function tokens(address) view returns (address deployer)',
  // NB: the protocol fee-model constants (MIN/MAX_BASKET_FEE_BPS, BURN_SHARE_BPS,
  // INTERFACE_SHARE_BPS, CRANK_BOUNTY_BPS) are NOT factory getters — they are
  // fixed protocol constants the FE mirrors from verified bytecode (fee-model.ts).
  // Do not re-add them here.
  // ── Dutch auction — only currentDeployPrice() is exposed; the
  // named auction getters never existed on-chain (slotStartPrice/lastDeployBlock
  // are public if a richer readout is wanted later). ──
  'function currentDeployPrice() view returns (uint256)',
])

// Deploy + salt-mining surface. predictTokenAddress includes the fee config —
// the fee config is CREATE2-committed, so it is a salt-mining input.
export const factoryDeployAbi = parseAbi([
  // Arg order is load-bearing: predictTokenAddress recomputes the init-code from
  // this exact tuple, so the mined salt only predicts the real address if the
  // order + field names match the deployed factory.
  `function deployBasket(bytes32 salt, string name, string symbol, ${BASKET_ENTRY}[] basket, uint160 startSqrtPriceX96, uint256 maxCost, ${FEE_CONFIG} feeConfig) payable returns (address token)`,
  `function predictTokenAddress(bytes32 salt, ${BASKET_ENTRY}[] basket, address deployer, ${FEE_CONFIG} feeConfig) view returns (address)`,
  'function currentDeployPrice() view returns (uint256)',
])

// Launch event — kept for enrichment (inception timestamps) and tx
// parsing. It appends the headline `basketFeeBps`; the burn/interface/launcher
// shares are fixed protocol constants and are NOT emitted here. The creator
// share / payout / launcher are emitted by the token's `FeeConfigured` event at
// initialize() — (uint16 basketFeeBps, uint16 creatorShareBps, address
// creatorPayout, address launcher); the FE does not currently decode it.
export const launchedEvent = parseAbiItem(
  'event Launched(address indexed basket, address indexed deployer, string name, string symbol, uint160 startSqrtPriceX96, uint256 ethPaid, uint16 basketFeeBps)',
)
