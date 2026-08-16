import { showSymbol } from './safe-copy'

// ─────────────────────────────────────────────────────────────────────────────
// RULE 6 AS DETECT-AND-DISCLOSE (desk 250; the shape was ruled, not invented
// here: "do not budget for enforcement we cannot give").
//
// ⚠ WHY THIS IS NOT A PROTECTION, and saying so is the whole point. A dapp
// CANNOT force a private mempool for a standard EOA. The wallet owns
// transaction submission; we hand it calldata and it broadcasts however it
// broadcasts. Any "MEV protection" claim we made would be a control announcing
// something it never had — this lane's recurring sin, and the reason the ruling
// was disclosure rather than defence.
//
// WHAT IS ACTUALLY TRUE, and what a person deserves to be told before signing:
// a portfolio batch publishes the WHOLE COMPOSITION in ONE mempool object.
// That is qualitatively different from a single swap, in two ways a user would
// not guess:
//   1. IT IS COPY-TRADEABLE. Every asset and every weight is legible to anyone
//      watching the pending pool, attributed to the signer's address. A single
//      swap leaks one position; a batch leaks a STRATEGY.
//   2. IT IS A LEGIBLE SANDWICH TARGET. The auditor's point: one object states
//      exactly which pools are about to be bought and with how much, so the
//      profitable ordering is computable before the transaction lands. The
//      per-leg floors bound the LOSS (that is what floor discipline is for);
//      they do not prevent the extraction.
//
// AND WHERE A PROTECTED PATH GENUINELY EXISTS we say that instead: a 5792
// atomic bundle goes to the wallet's own bundler rather than the public pool,
// which is a real difference in exposure and one the user did not choose — so
// it is stated as a FACT about their wallet, never as a guarantee from us.
// ─────────────────────────────────────────────────────────────────────────────

export type MempoolPath = 'public-pool' | 'wallet-bundler'

export interface MempoolExposure {
  path: MempoolPath
  /** How many positions this one object reveals at once. */
  legCount: number
  /** Symbols, bounded and inert — this text goes on a money surface. */
  shownSymbols: string[]
  /** The sentence to show. Plain, specific, and never reassuring beyond fact. */
  disclosure: string
  /** True only where the wallet's own submission path is not the public pool.
   *  NOT a promise: bundlers vary and some forward to the public pool anyway. */
  reducedExposure: boolean
}

/**
 * Describe what signing this batch reveals. `atomicBundle` is the ladder's own
 * answer for this chain (5792), so the disclosure follows the path the run will
 * ACTUALLY take rather than the one we would prefer.
 */
export function mempoolExposureOf(args: { symbols: readonly string[]; atomicBundle: boolean }): MempoolExposure {
  const shownSymbols = args.symbols.map((s) => showSymbol(s))
  const legCount = shownSymbols.length
  const list = shownSymbols.length <= 3 ? shownSymbols.join(', ') : `${shownSymbols.slice(0, 3).join(', ')} and ${shownSymbols.length - 3} more`

  if (args.atomicBundle) {
    return {
      path: 'wallet-bundler',
      legCount,
      shownSymbols,
      reducedExposure: true,
      disclosure:
        legCount === 0
          ? 'Your wallet submits this through its own bundler rather than the public queue, so less of it is visible while it waits.'
          : `Your wallet submits this through its own bundler rather than the public queue, so less of it is visible while it waits. It still contains your whole plan — ${list} — in one transaction.`,
    }
  }
  return {
    path: 'public-pool',
    legCount,
    shownSymbols,
    reducedExposure: false,
    disclosure:
      legCount === 0
        ? 'This transaction is visible in the public queue before it settles.'
        : `This transaction is visible in the public queue before it settles, and it contains your whole plan at once — ${list}. Anyone watching can read what you are buying and in what proportion, and can trade ahead of it. Your protection floors limit what that can cost you; they do not hide the plan.`,
  }
}
