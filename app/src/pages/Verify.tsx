import { useEffect, useState } from 'react'
import type { Address } from 'viem'
import { normalize } from 'viem/ens'
import { SUPPORTED_CHAIN_IDS, chainCfg } from '../lib/chain/chains'
import { deploymentFor } from '../lib/chain/deployments'
import { clientFor } from '../lib/chain/rpc'
import { MAINNET_CHAIN_ID } from '../lib/chain/constants'
import { addressFingerprint } from '../lib/verify/fingerprint'
import { DEPLOYER_ANCHOR_ENS, verifyChainConfig, type VerifiedField } from '../lib/verify/anchor'
import { shortAddr } from '../lib/spectrum/format'

// ─────────────────────────────────────────────────────────────────────────────
// /verify — "verify the contract, not the site" (anti-copycat Ring 1, ported
// from the pre-merge kit PR #18 onto the operator app). Always routable, no
// page toggle: any visitor on ANY deployment of this kit can see exactly which
// contracts the build is wired to, whether they are the canonical Spectrum
// deployment or an operator's own, and the protocol's published deployer
// identity — with fingerprints humans can actually compare (address-poisoning
// look-alikes fingerprint differently, every byte feeds the hash).
// ─────────────────────────────────────────────────────────────────────────────

function FingerprintChip({ address }: { address: string }) {
  const fp = addressFingerprint(address)
  if (!fp.valid) return null
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-white/12 px-2.5 py-1"
      style={{ background: `linear-gradient(90deg, hsl(${fp.hueA} 70% 22% / 0.55), hsl(${fp.hueB} 70% 22% / 0.55))` }}
      title="A fingerprint of the WHOLE address — a look-alike address renders a different one"
    >
      <span className="text-sm leading-none" aria-hidden>{fp.emoji}</span>
      <span className="font-mono text-[10px] tracking-wide text-ink">{fp.words}</span>
    </span>
  )
}

function VerdictBadge({ verdict }: { verdict: VerifiedField['verdict'] }) {
  if (verdict === 'canonical')
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-teal/40 bg-teal/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-teal">
        ✓ Canonical Spectrum
      </span>
    )
  if (verdict === 'override')
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-amber-300">
        ⚠ Operator override
      </span>
    )
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-white/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
      Not configured
    </span>
  )
}

function AddressRow({ field, explorer }: { field: VerifiedField; explorer: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-white/[0.06] py-3 first:border-t-0">
      <span className="w-28 shrink-0 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-dim">{field.label}</span>
      {field.effective ? (
        <>
          <FingerprintChip address={field.effective} />
          <a
            href={`${explorer}/address/${field.effective}`}
            target="_blank"
            rel="noreferrer"
            className="break-all font-mono text-[11px] text-cyan underline-offset-4 hover:underline"
          >
            {field.effective}
          </a>
        </>
      ) : (
        <span className="font-mono text-[11px] text-ink-faint">—</span>
      )}
      <span className="ml-auto"><VerdictBadge verdict={field.verdict} /></span>
      {field.verdict === 'override' && field.canonical && (
        <p className="w-full font-mono text-[10px] leading-relaxed text-ink-faint">
          This site routes through its own {field.label.toLowerCase()}, not the canonical{' '}
          {shortAddr(field.canonical)}. That can be legitimate (an operator serving their own
          deployment) — decide whether you trust this operator before transacting.
        </p>
      )}
    </div>
  )
}

export function Verify() {
  // The protocol's deployer identity — resolved LIVE from mainnet ENS every visit
  // (never a baked address). Failure renders honestly as unresolvable.
  const [anchor, setAnchor] = useState<{ state: 'loading' | 'ok' | 'error'; address?: Address }>({ state: 'loading' })
  useEffect(() => {
    let stale = false
    clientFor(MAINNET_CHAIN_ID)
      .getEnsAddress({ name: normalize(DEPLOYER_ANCHOR_ENS) })
      .then((a) => {
        if (!stale) setAnchor(a ? { state: 'ok', address: a } : { state: 'error' })
      })
      .catch(() => {
        if (!stale) setAnchor({ state: 'error' })
      })
    return () => {
      stale = true
    }
  }, [])

  return (
    <div className="mx-auto max-w-3xl px-6 py-14">
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">Contract verification</div>
      <h1 className="mt-2 font-display text-4xl font-bold tracking-tight text-ink">Verify the contract, not the site</h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-dim">
        Anyone can copy a front end. What can&rsquo;t be faked are the contract addresses a site
        transacts through. Below is exactly what this build is wired to, compared against the
        canonical Spectrum deployment shipped in this kit&rsquo;s address book — with fingerprints
        you can compare at a glance (a look-alike address produces a different fingerprint,
        because every byte of the address feeds it).
      </p>

      {SUPPORTED_CHAIN_IDS.map((chainId) => {
        const cfg = chainCfg(chainId)
        const dep = deploymentFor(chainId)
        const fields = verifyChainConfig(chainId, {
          factory: dep.factory,
          swapRouter: dep.swapRouter,
          usdc: dep.usdc,
        })
        return (
          <section key={chainId} className="mt-8 rounded-2xl card-surface p-6">
            <h2 className="font-display text-xl font-bold text-ink">{cfg.name}</h2>
            <div className="mt-3">
              {fields.map((f) => (
                <AddressRow key={f.key} field={f} explorer={cfg.explorer} />
              ))}
            </div>
          </section>
        )
      })}

      <section className="mt-8 rounded-2xl card-surface p-6">
        <h2 className="font-display text-xl font-bold text-ink">The deployer identity</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-dim">
          The canonical Spectrum contracts were deployed by the protocol&rsquo;s developer, published
          as the ENS name <span className="font-mono text-ink">{DEPLOYER_ANCHOR_ENS}</span> — resolved
          live from Ethereum below, never baked into this kit.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {anchor.state === 'loading' && <span className="font-mono text-[11px] text-ink-faint">Resolving…</span>}
          {anchor.state === 'ok' && anchor.address && (
            <>
              <FingerprintChip address={anchor.address} />
              <a
                href={`${chainCfg(MAINNET_CHAIN_ID).explorer}/address/${anchor.address}`}
                target="_blank"
                rel="noreferrer"
                className="break-all font-mono text-[11px] text-cyan underline-offset-4 hover:underline"
              >
                {anchor.address}
              </a>
            </>
          )}
          {anchor.state === 'error' && (
            <span className="font-mono text-[11px] text-amber-300">
              Could not resolve {DEPLOYER_ANCHOR_ENS} right now — that means unverifiable, not genuine. Retry later.
            </span>
          )}
        </div>
        <p className="mt-3 font-mono text-[10px] leading-relaxed text-ink-faint">
          To check for yourself: open a factory address above on the explorer and confirm its
          creation transaction came from this deployer. Any other &ldquo;Spectrum&rdquo; factory is unofficial.
        </p>
      </section>

      <p className="mt-8 rounded-xl border border-white/10 bg-white/[0.02] p-4 font-mono text-[11px] leading-relaxed text-ink-dim">
        An authentic contract is not a safety verdict on any basket. Baskets are permissionless:
        anyone can launch one on the canonical factory, including bad ones. Verifying contracts
        protects you from fake infrastructure — judging a basket is still on you.
      </p>
    </div>
  )
}
