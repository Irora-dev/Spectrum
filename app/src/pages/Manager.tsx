import { BundleHero } from '../components/BundleHero'
import { CreateSurface } from '../components/allocate/CreateSurface'

// ─────────────────────────────────────────────────────────────────────────────
// /CREATE (né /manager) — the thin page mount of the Create surface. ALL of
// the money-adjacent machinery (guest scope, draft adoption, resume, the
// connect-when-money-enters beat) lives in components/allocate/CreateSurface —
// one implementation, mounted here with the masthead and on Home embedded
// under its hero (`<Manager embedded />` — UIGuy's mount keeps working; Home
// can also point at CreateSurface directly).
// ─────────────────────────────────────────────────────────────────────────────

const fixtureMode = import.meta.env.VITE_DEV_FIXTURE === '1'

export function Manager({ embedded = false }: { embedded?: boolean }) {
  if (embedded) return <CreateSurface embedded />

  return (
    <CreateSurface
      masthead={(connecting) => (
        // Compact masthead — the 20:42 treatment: tall dim art, gentle fade,
        // bright centred title (text-center parent = the inline-block rule).
        <BundleHero minH="56svh" dim softFade>
          <div className="w-full text-center">
            {/* Owner 2026-08-07: the title says what the page MAKES, not what
                it buys. No manual <br/> — at 26ch text-wrap:balance splits it
                two-up ("…tokens from" / "assets across EVM chains") at every
                width the old hard break was tuned for. */}
            <h1 className="spectrum-wordmark spectrum-wordmark--bright max-w-[26ch] text-center font-display text-4xl font-bold uppercase leading-[0.95] tracking-tight [text-wrap:balance] sm:text-5xl md:text-6xl">
              Create basket tokens from assets across EVM chains
            </h1>
            {connecting && (
              <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.14em] text-amber-300/90">
                {fixtureMode ? 'connecting — simulated wallet, no signature' : 'connecting…'}
              </p>
            )}
          </div>
        </BundleHero>
      )}
    />
  )
}
