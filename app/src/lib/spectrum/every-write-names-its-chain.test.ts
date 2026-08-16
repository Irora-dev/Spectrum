import { describe, expect, it } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// EVERY WALLET WRITE NAMES ITS CHAIN — a structural law, enforced structurally.
//
// Four-reviewer audit, 2026-08-07: LimitTicket's two relayer approves were the
// ONLY writes in the app without a `chainId`, and the switch above them
// resolves OPTIMISTICALLY on wallets that report a network switch they did not
// make. An approve carrying no chainId then lands on whatever chain the wallet
// is really on — where the same token address is a DIFFERENT token, now
// approved to the relayer. With the id present, wagmi refuses the mismatch.
//
// The audit could only find the two misses that existed; this sweep makes the
// NEXT write site safe by construction. Source is read via vite's own glob
// (raw), so the test needs no node API and runs wherever the suite runs.
// NOTE for the next reader: wagmi's registered-config overload wants a LITERAL
// chain id at some sites (a plain number resolves the mutation to `never`) —
// the honest fix is a checked type-guard narrowing, never a cast; see
// LimitTicket's place() for the precedent.
// ─────────────────────────────────────────────────────────────────────────────

const SOURCES = import.meta.glob(['/src/**/*.ts', '/src/**/*.tsx', '!/src/**/*.test.*'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const WRITE_CALLS = /(writeContractAsync|sendTransactionAsync|sendCallsAsync)\(\{/g

/** The call's argument block, brace-balanced from the opening `{`. */
function argBlock(text: string, from: number): string {
  let depth = 0
  for (let j = from; j < text.length; j++) {
    if (text[j] === '{') depth += 1
    else if (text[j] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(from, j + 1)
    }
  }
  return text.slice(from)
}

describe('every wallet write names its chain', () => {
  it('no writeContractAsync / sendTransactionAsync / sendCallsAsync call omits chainId', () => {
    const offenders: string[] = []
    let sites = 0
    for (const [file, text] of Object.entries(SOURCES)) {
      for (const m of text.matchAll(WRITE_CALLS)) {
        sites += 1
        const block = argBlock(text, (m.index ?? 0) + m[0].length - 1)
        if (!/\bchainId\b/.test(block)) {
          const line = text.slice(0, m.index).split('\n').length
          offenders.push(`${file}:${line} ${m[1]}`)
        }
      }
    }
    // the sweep must have LOOKED — zero sites means the glob broke, not that
    // the app stopped writing (the coverage-denominator law)
    expect(sites).toBeGreaterThan(40)
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})
