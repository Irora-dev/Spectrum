import type { ReactNode } from 'react'
import { Link, Route, Routes, useLocation, useParams } from 'react-router'
import { isAddress } from 'viem'
import { useAccount } from 'wagmi'
import { checkHandle, HANDLE_FAULT_WORDS, handleStateIn } from '../../lib/spectrum/creator-handles'
import { useAddressForHandle, useHandleRegistry } from '../../lib/spectrum/use-handles'
import { ownerAddress } from '../../lib/spectrum/handle-registry'
import { ClaimHandle } from './ClaimHandle'

// ─────────────────────────────────────────────────────────────────────────────
// /creator/:idOrHandle — one route, two kinds of value (spec: workspace/
// spectrum-release/creator-handles-spec.md).
//
// THE ADDRESS FORM ALWAYS WORKS. It resolves with zero network reads, before
// any handle lookup is even attempted, because every /creator/0x… link already
// shared in the wild has to keep working forever. A handle is the nicer URL on
// top, never a migration off the old one.
//
// The creator page itself is untouched: it reads `:address` from the router, so
// once a name resolves this re-runs the match against a SYNTHETIC location
// carrying the address. React Router supports exactly that (`<Routes location>`
// is how modal-over-page routes work), and it means the browser keeps showing
// /creator/basedresearch while the page below reads the address it always did.
// ─────────────────────────────────────────────────────────────────────────────

/** Renders the creator page with `:address` bound to `address`, while the URL
 *  bar keeps whatever the visitor actually typed. `base` is the parent route's
 *  own path ('/creator' or '/c'), which the nested match is measured from.
 *
 *  Search, hash and state are carried over from the REAL location, so the ONLY
 *  thing this rewrites is the path segment. Passing a bare pathname would blank
 *  the query string for anything below that reads it. */
function CreatorAt({ base, address, element }: { base: string; address: string; element: ReactNode }) {
  const { search, hash, state, key } = useLocation()
  return (
    <Routes location={{ pathname: `${base}/${address}`, search, hash, state, key }}>
      <Route path=":address" element={element} />
    </Routes>
  )
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid min-h-[50vh] place-items-center px-4">
      <div className="max-w-md text-center">
        <h1 className="font-display text-2xl font-semibold uppercase tracking-tight text-ink sm:text-3xl">
          {title}
        </h1>
        <div className="mt-4 text-sm leading-relaxed text-ink-dim">{children}</div>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            to="/explore"
            className="rounded-lg border border-white/20 bg-white/[0.04] px-5 py-2.5 font-mono text-xs uppercase tracking-[0.18em] text-ink press hover:border-cyan hover:text-cyan"
          >
            Explore baskets
          </Link>
          <Link
            to="/"
            className="rounded-lg border border-white/12 px-5 py-2.5 font-mono text-xs uppercase tracking-[0.18em] text-ink-faint press hover:border-white/30 hover:text-ink"
          >
            Home
          </Link>
        </div>
      </div>
    </div>
  )
}

export function CreatorRoute({ base, element }: { base: string; element: ReactNode }) {
  // The splat is everything after the parent path. A creator URL is one
  // segment, so anything deeper is a stale or hand-edited link.
  const rest = useParams()['*'] ?? ''
  const typed = rest.split('/')[0] ?? ''
  const isAddressUrl = isAddress(typed, { strict: false })
  const shaped = checkHandle(typed)
  // Ask only when the value could actually BE a name. A malformed one costs no
  // read at all, and the address form never waits for a lookup.
  const askFor = !isAddressUrl && shaped.ok ? shaped.handle.normalized : null
  const { lookup, loading, refetch } = useAddressForHandle(askFor)
  // For the RETIRED page's reclaim act only: the connected wallet + the map the
  // lookup above already resolved (enabled:false — reads the shared cache, never
  // triggers a second scan). Hooks live above every return in this component.
  const { address: viewer } = useAccount()
  const { data: registryData } = useHandleRegistry(false)

  // 1. An address: straight through, no lookup, no waiting. The permanent form.
  if (isAddressUrl) return <CreatorAt base={base} address={typed} element={element} />

  if (!typed) {
    return (
      <Panel title="No creator here">
        <p>That link is missing the creator. Open a creator from a basket, or browse the ones with baskets live.</p>
      </Panel>
    )
  }

  // 2. Not an address and not a possible name: say which rule it breaks.
  if (!shaped.ok) {
    return (
      <Panel title="Not a creator name">
        <p>
          <span className="text-ink">{typed.slice(0, 40)}</span> cannot be a creator name, because{' '}
          {HANDLE_FAULT_WORDS[shaped.fault]}.
        </p>
      </Panel>
    )
  }

  const name = shaped.handle.display

  if (loading) {
    return (
      <div className="grid min-h-[50vh] place-items-center" aria-label="Looking up this creator" role="status">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/15 border-t-cyan" />
      </div>
    )
  }

  // 3. Resolved to a creator: the page, with the pretty URL still in the bar.
  if (lookup.status === 'found') {
    return <CreatorAt base={base} address={ownerAddress(lookup.owner)} element={element} />
  }

  // 4. The read did not finish. NEVER pose this as "nobody has that name" — the
  //    name may well be someone's, and the honest move is to offer a retry.
  if (lookup.status === 'unknown') {
    return (
      <Panel title="Could not check that name">
        <p>
          We could not read who owns <span className="text-ink">{name}</span> just now, so we will not guess. Try
          again in a moment.
        </p>
        <p className="mt-3">Creator pages always open with the wallet address, whatever the network is doing.</p>
        <button
          type="button"
          onClick={refetch}
          className="mt-5 rounded-lg border border-cyan/50 px-5 py-2.5 font-mono text-xs uppercase tracking-[0.18em] text-cyan press hover:bg-cyan/10"
        >
          Try again
        </button>
      </Panel>
    )
  }

  // 5. Retired by a rename: it points at nobody, on purpose, forever unless the
  //    creator who held it takes it back (spec §5).
  if (lookup.status === 'retired') {
    // THE ONE WALLET that can revive a retired name is told so, with the form
    // ready (QOL round 2 2026-08-06): handleStateIn answers 'reclaimable' only
    // for the past holder, so nobody else ever sees the offer.
    const map = registryData?.status === 'ok' ? registryData.map : null
    const mine = !!map && !!viewer && handleStateIn(map, name, viewer).state === 'reclaimable'
    return (
      <div className="grid min-h-[50vh] place-items-center px-4 py-12">
        <div className="w-full max-w-md">
          <div className="text-center">
            <h1 className="font-display text-2xl font-semibold uppercase tracking-tight text-ink sm:text-3xl">
              That name was retired
            </h1>
            <p className="mt-4 text-sm leading-relaxed text-ink-dim">
              <span className="text-ink">{name}</span> was used by a creator who has since changed their name, so
              it no longer points at anyone.
            </p>
            <p className="mt-3 text-sm leading-relaxed text-ink-dim">
              {mine
                ? 'It was yours — and it still answers to you.'
                : 'It is not free either. Only the creator who had it can take it back, so an old link can never quietly lead to someone else.'}
            </p>
          </div>
          {mine && <ClaimHandle className="mt-8" initialName={name} />}
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              to="/explore"
              className="rounded-lg border border-white/20 bg-white/[0.04] px-5 py-2.5 font-mono text-xs uppercase tracking-[0.18em] text-ink press hover:border-cyan hover:text-cyan"
            >
              Explore baskets
            </Link>
            <Link
              to="/"
              className="rounded-lg border border-white/12 px-5 py-2.5 font-mono text-xs uppercase tracking-[0.18em] text-ink-faint press hover:border-white/30 hover:text-ink"
            >
              Home
            </Link>
          </div>
        </div>
      </div>
    )
  }

  // 6. Simply unclaimed — which is an INVITATION, not a dead end: the visitor
  //    is literally looking at the URL they want, so the claim form opens on
  //    it (QOL round 2026-08-06). ClaimHandle renders nothing on wallet-off
  //    builds, where the prose above still carries the whole answer.
  return (
    <div className="grid min-h-[50vh] place-items-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="text-center">
          <h1 className="font-display text-2xl font-semibold uppercase tracking-tight text-ink sm:text-3xl">
            Nobody goes by that name
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-ink-dim">
            <span className="text-ink">{name}</span> has not been claimed. Names go to the creator who asks
            first.
          </p>
        </div>
        <ClaimHandle className="mt-8" initialName={name} />
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            to="/explore"
            className="rounded-lg border border-white/20 bg-white/[0.04] px-5 py-2.5 font-mono text-xs uppercase tracking-[0.18em] text-ink press hover:border-cyan hover:text-cyan"
          >
            Explore baskets
          </Link>
          <Link
            to="/"
            className="rounded-lg border border-white/12 px-5 py-2.5 font-mono text-xs uppercase tracking-[0.18em] text-ink-faint press hover:border-white/30 hover:text-ink"
          >
            Home
          </Link>
        </div>
      </div>
    </div>
  )
}
