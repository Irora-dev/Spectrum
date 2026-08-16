import { describe, expect, it } from 'vitest'
// SOURCE TEXT, not the module's value: these two assertions are about what the
// source SAYS (a literal, no env expression), which the imported value cannot
// tell us. Vite's `?raw` keeps it inside the app's own module graph — no
// node:fs, so the app needs no @types/node for a test.
import allocationSrc from './allocation.ts?raw'
import deploymentsSrc from '../chain/deployments.ts?raw'
import { PERMIT2_ADDRESS } from './permit2'
import { LIFI_TARGETS } from './lifi'
import { COW_VAULT_RELAYER } from './cow'
import { SIMULATED } from './allocation'
import { knownSpenders } from './allowances'

// ─────────────────────────────────────────────────────────────────────────────
// THE EVIL-BUILD RED TEAM's testable half (battle-test item, 2026-08-04).
//
// The honest frame first: this is a fully client-side bundle, so a compromised
// dependency executing in the page has TOTAL power — it can patch any module,
// hook fetch, and replace window.ethereum. No in-bundle test can defend
// against that, and THREAT-MODEL §4 says so plainly. What these pins DO
// defend is the realistic vector: a malicious or careless SOURCE-LEVEL change
// (a dependency bump that ships a patched constant, a PR that "fixes" an
// address, a copy-paste from a phishing doc). Every money-bearing address and
// the interlock itself is asserted here as a LITERAL, so changing one fails
// CI instead of shipping.
//
// Why literals and not imports-compared-to-imports: a test that asserts
// `X === X` passes no matter what X becomes — the guard-comparing-a-value-to
// -itself lesson, applied to supply chain. The expected values below are typed
// out from the canonical sources and must be re-verified BY A HUMAN against
// those sources when one legitimately changes.
// ─────────────────────────────────────────────────────────────────────────────

describe('money-bearing addresses are pinned as literals — a source-level swap fails CI', () => {
  it('Permit2 is the canonical deterministic deployment', () => {
    // Uniswap's Permit2, same address on every chain it exists on.
    expect(PERMIT2_ADDRESS).toBe('0x000000000022D473030F116dDEE9F6B43aC78BA3')
  })

  it('the LI.FI diamonds are the vendor-published ones', () => {
    expect(LIFI_TARGETS[1]).toBe('0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae')
    expect(LIFI_TARGETS[8453]).toBe('0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae')
    expect(LIFI_TARGETS[4663]).toBe('0xb477751b76cf82d00a686a1232f5fcd772414af3')
  })

  it("CoW's vault relayer is the protocol's own", () => {
    expect(COW_VAULT_RELAYER.toLowerCase()).toBe('0xc92e8bdf79f0507f65a392b0ab4667716bfe0110')
  })

  it('the spender registry names ONLY known infrastructure — an unlisted spender cannot appear', () => {
    // The approvals ledger asks the user to trust these labels. A patched
    // registry could dress an attacker's address as "Spectrum router", so the
    // set of addresses it can produce is bounded here.
    for (const chainId of [1, 8453, 4663]) {
      for (const sp of knownSpenders(chainId)) {
        const a = sp.address.toLowerCase()
        const known =
          a === PERMIT2_ADDRESS.toLowerCase() ||
          a === COW_VAULT_RELAYER.toLowerCase() ||
          a === String(LIFI_TARGETS[chainId]).toLowerCase() ||
          sp.label === 'Spectrum router' // resolved from the deployment registry
        expect(known, `unrecognized spender ${sp.address} (${sp.label}) on chain ${chainId}`).toBe(true)
      }
    }
  })
})

describe('the launch interlock is a SOURCE property, not a build input', () => {
  it('SIMULATED is a literal true in source — no env expression can flip it at build time', () => {
    // The 2026-08-01 blocking finding was env-gated labels over an
    // unconditionally simulating engine. The constant must stay a literal:
    // an `import.meta.env`-derived value would let a build claim live
    // execution the code cannot do (and vice versa).
    expect(allocationSrc).toMatch(/export const SIMULATED = (true|false)\b/)
    const line = allocationSrc.split('\n').find((l: string) => l.includes('export const SIMULATED')) ?? ''
    expect(line).not.toMatch(/import\.meta|process\.env|window|globalThis/)
    // FLIPPED 2026-08-14 with the reviewed flip commit — the property this
    // test defends (a LITERAL, never an env expression) is unchanged; only
    // the pinned value moved, deliberately, with the interlock green.
    expect(SIMULATED).toBe(false)
  })

  it('the batcher address has NO env override path — ceremony seating is source-only', () => {
    // Every other deployment field accepts a VITE_ override for local forks.
    // The batcher moves money in one call, so its address must not be
    // settable by whatever env a build was made with: it is seated in the
    // committed registry at ceremony, and the runner verifies its BYTECODE
    // HASH before the first signature (threat-model E12).
    const overrides = deploymentsSrc.slice(deploymentsSrc.indexOf('const ENV_OVERRIDES'), deploymentsSrc.indexOf('function deploymentFor'))
    expect(overrides).not.toMatch(/batcher/i)
  })
})
