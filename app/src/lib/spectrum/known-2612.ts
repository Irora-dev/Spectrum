// ─────────────────────────────────────────────────────────────────────────────
// KNOWN-GOOD EIP-2612 TOKENS — the ladder's rung 3 (readiness §5b). A LIST,
// not a probe: 2612 in the wild is inconsistent (DAI's permit predates the
// standard and differs; some tokens expose the selector and revert; some
// verify wrongly). A wrong guess costs a failed signature prompt at best and
// a stuck run at worst, so membership here means SOMEONE VERIFIED IT — add
// rows with a source, never by pattern-matching a selector.
// ─────────────────────────────────────────────────────────────────────────────

/** `${chainId}:${lowercased address}` → true. Funding assets only — that is
 *  the only approval rung 3 serves. */
const KNOWN_2612 = new Set<string>([
  // native USDC, Circle's FiatTokenV2_2 — permit verified in production use
  '8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC on Base
  '1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC on Ethereum
])

export function has2612(chainId: number, token: string): boolean {
  return KNOWN_2612.has(`${chainId}:${token.toLowerCase()}`)
}
