// Integrator docs — keep copy mechanism-factual.
import { useEffect, useState } from 'react'
import { PageHeader } from '../components/PageHeader'
import { Link } from 'react-router-dom'
import {
  Callout,
  Checklist,
  CodeBlock,
  DocSection,
  IC,
  InfoPop,
  Table,
  Toc,
} from '../components/DocKit'
import { AddrChips } from '../components/AddrChips'
import { IndexingReference } from '../components/IndexingReference'
import { SpectralSearch } from '../components/SpectralSearch'

// ── copyable snippets (kept verbatim so copy/paste is exact) ──────────────────
const NAV_VIEWS = `// V2 static NAV views, non-reverting, display-grade (value, priced) marks:
exchangeRate()  returns (uint256 rate1e18, bool fullyPriced)  // USDC per token, 1e18-scaled
totalReserve()  returns (uint256 usdcValue, bool fullyPriced) // total backing, USDC (6 dec)
quoteLeg(i)     returns (uint256 usdcValue, bool priced)      // one constituent's mark
effectiveSupply() returns (uint256)                           // NAV denominator`

const RECON = `# Aggregate-spot cross-check (also the fallback when views are unavailable)
AUM_usd = 0
for i in 0 .. basketLength()-1:
    (asset, _, _, _, _, _, dec) = basket(i)
    held   = idleHeld(asset)               # raw, asset decimals (tracked reserve)
    price  = priceUsd(asset)               # your price source; canonical USDC -> 1.0
    AUM_usd += (held / 10**dec) * price

navPerToken = AUM_usd / (effectiveSupply() / 1e18)`

const FEE_ABI = `// Per-basket immutable fee config (creator picks the rate + their own share):
basketFeeBps()     returns (uint16)   // total fee in bps (100-300)
creatorShareBps()  returns (uint16)   // creator's share of the remainder (0-3000 = 0-30%)
creatorPayout()    returns (address)  // where the creator share is sent (0x0 = none)
launcher()         returns (address)  // per-basket origination recipient (0x0 = none)
// Fixed protocol constants (same on every basket, no ratchet, no routing table):
BURN_SHARE_BPS = 1000        // 10% PRISM burn of every fee (+ all rounding dust)
INTERFACE_SHARE_BPS = 555    // ~5% of the fee; carved off the post-burn base only
LAUNCHER_SHARE_BPS  = 555    //   when a frontend tag / launcher is present
MAX_CREATOR_SHARE_BPS = 3000 // creator <=30% of remainder => holders >=70% of it
MIN_BASKET_FEE_BPS = 100 / MAX_BASKET_FEE_BPS = 300 / CRANK_BOUNTY_BPS = 50
// Waterfall: burn 10% off the top; then (if present) interface 555/bps and
// launcher 555/bps of the post-burn base; creatorShareBps of what remains to
// creatorPayout; holders get the rest. Unused interface/launcher slices stay in
// the remainder -> creator + holders. No burnShareBps() getter; no routes().`

const HOOKDATA = `// hookData is OPTIONAL (v3). TAGGED path: frontends encoding floors + attribution.
abi.encode(
  uint256   minOut,    // aggregate minimum out
  uint256[] legMins,   // per-leg minimums: quotedLeg[i] * (1 - slippageBps/10000)
  address   frontend   // interface tag; address(0) = none (interface slice not carved → stays in remainder)
)
// BARE path (empty hookData: generic aggregators / canonical v4 routers):
// minOut = 0 (the caller's settlement check owns slippage) and a buy gets
// in-protocol per-leg floors from the factory's immutable TWAP lens.
// EXCEPTION: the FIRST mint (effectiveSupply() == 0) still hard-requires the
// full tagged payload with non-zero legMins on every swapped leg, since it sets
// the share basis every future holder inherits.`

const REDEEM_IN_KIND = `// Unconditional exit, works even if every pool is dead:
redeemInKind(uint256 amount, bool[] legMask, address to)
// Constituents-out ONLY, pro-rata, deterministic, no minOuts; never touches
// USDC or any pool. legMask[i] = false skips a frozen/reverting leg explicitly
// (the skipped share stays in reserve for remaining holders).`

const DISCOVERY = `// Keyless enumeration, the factory keeps an append-only public array:
allBasketsLength() returns (uint256)
allBaskets(i)      returns (address)
// tokens(basket) returns (address deployer): on-chain creator attribution.
// The Launched event remains for enrichment (inception timestamps).`

const TOC = [
  { id: 'what', label: '1 · What a basket is' },
  { id: 'nav', label: '2 · Reading NAV' },
  { id: 'recon', label: '3 · Cross-check / fallback' },
  { id: 'fees', label: '4 · Per-basket fees' },
  { id: 'hookdata', label: '5 · hookData / legMins' },
  { id: 'exit', label: '6 · In-kind redemption' },
  { id: 'discover', label: '7 · Discovering baskets' },
  { id: 'direct', label: '8 · Direct contract access' },
  { id: 'gotchas', label: '9 · Gotchas' },
  { id: 'addresses', label: '10 · Addresses' },
  { id: 'indexing', label: '11 · Indexing / events' },
]

export function Docs() {
  // Docs search (owner 16:48): a chapter hides when its RENDERED text doesn't
  // contain the query — honest full-text, no hand-kept keyword lists.
  const [dq, setDq] = useState('')
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set())
  useEffect(() => {
    const q = dq.trim().toLowerCase()
    if (!q) {
      setHiddenIds(new Set())
      return
    }
    const h = new Set<string>()
    for (const { id } of TOC) {
      const el = document.getElementById(id)
      if (el && !(el.textContent ?? '').toLowerCase().includes(q)) h.add(id)
    }
    setHiddenIds(h)
  }, [dq])
  const hide = (id: string) => (hiddenIds.has(id) ? 'hidden' : '')

  return (
    <div className="py-4">
      <Link
        to="/"
        className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-faint press hover:text-ink"
      >
        ← Back to Spectrum
      </Link>

      {/* ONE card behind the whole guide (owner 17:08: dense dark material
          needs to come off the page) */}
      <div className="mt-5 rounded-3xl border border-white/[0.14] bg-white/[0.05] p-5 shadow-[0_30px_80px_-40px_rgba(0,0,0,0.8)] backdrop-blur-sm sm:p-10">
      {/* header — eyebrow line dropped, the intro runs wider (owner 16:48) */}
      <header className="border-b border-white/10 pb-8">
        <PageHeader title="Reading a Spectrum basket" />
        <p className="mt-5 max-w-4xl text-base leading-relaxed text-ink-dim">
          For builders, price feeds, and dashboards reading Spectrum baskets.
          Everything here works against a plain public RPC, no API key.
        </p>
        {/* full-text section search — chapters that don't mention the query
            hide; the bar is Explore's spectral search (owner 17:08) */}
        <div className="mt-6 max-w-md">
          <SpectralSearch value={dq} onChange={setDq} placeholder="Search the docs…" size="md" />
        </div>
      </header>

      {/* two-column: TOC + article */}
      <div className="mt-10 lg:grid lg:grid-cols-[210px_minmax(0,1fr)] lg:gap-12">
        <Toc items={TOC} />

        <article className="min-w-0 max-w-3xl space-y-12">
          {/* 1 — the page OPENS on what a basket is (owner 17:34); the pricing
              callouts live in the NAV chapter where they belong */}
          <DocSection id="what" className={hide('what')} n="01" title="What a Spectrum basket is">
            <p>
              A Spectrum basket is an ERC-20 token (<strong className="text-ink">18 decimals</strong>)
              backed by a fixed set of constituent tokens. The token is its own V4 hook and its own
              liquidity: minting deposits value against the constituents, redeeming returns it.
            </p>
            <Table
              head={['Thing', 'Value']}
              rows={[
                ['Basket token decimals', <strong className="text-ink">18</strong>],
                ['USDC (settlement asset)', <span><strong className="text-ink">6 decimals</strong>, canonical Base USDC</span>],
                ['Basket weights', <span>BPS (10000 = 100%), <em className="not-italic text-ink">target</em> weights; live weights drift with price</span>],
                ['Constituent decimals', <span><strong className="text-ink">varies</strong>, read per entry, never assume 18</span>],
              ]}
            />
          </DocSection>

          {/* 2 */}
          <DocSection id="nav" className={hide('nav')} n="02" title="Reading NAV: static views first">
            <p>
              The V2 token exposes static, non-reverting NAV views. They return display-grade marks
              with an explicit health flag, treat a <IC>fullyPriced == false</IC> result as partial,
              and never treat any of these as a manipulation-resistant oracle.
            </p>
            <Callout variant="note" title="Bottom line (V2 inverts the v1 guidance)">
              <p>
                Call <IC>exchangeRate()</IC>, in V2 it is now non-reverting, with a{' '}
                <IC>fullyPriced</IC> health flag. The aggregate-spot reconstruction (
                <a href="#recon" className="text-cyan hover:underline">§3</a>) remains the
                manipulation-resistant cross-check and the fallback. Settlement is canonical Base USDC.
              </p>
            </Callout>
            <CodeBlock tone="bright" code={NAV_VIEWS} title="static NAV views · V2" />
            <Callout variant="warn" title="Use idleHeld(asset), not balanceOf">
              <p>
                <IC>idleHeld</IC> is the basket&rsquo;s tracked, donation-immune reserve of a
                constituent; <IC>balanceOf</IC> can be inflated by tokens donated to the basket.
                Denominator is <IC>effectiveSupply()</IC>, not <IC>totalSupply()</IC>.{' '}
                <InfoPop>
                  <b className="text-ink">Why this matters.</b> Anyone can transfer tokens directly
                  to the basket address for free. <IC>balanceOf</IC> counts those donations, so a
                  $10 donation to a $100 basket inflates a balanceOf-based NAV by 10% with no
                  value behind it for minters. <IC>idleHeld</IC> only moves on real mint/redeem
                  flows, and <IC>effectiveSupply()</IC> excludes tokens queued for burn, which is
                  why the pair is the honest numerator and denominator.
                </InfoPop>
              </p>
            </Callout>
            <Callout variant="danger" title="Never price from the basket's own pool">
              <p>
                Each basket has an internal Uniswap v4 self-pool, but mint/redeem are hook-mediated, so
                that pool&rsquo;s price does <strong className="text-ink">not</strong> track value and is
                effectively static. An indexer that auto-detects that pool will publish a wrong price.{' '}
                <InfoPop>
                  <b className="text-ink">What the self-pool really is.</b> The basket&rsquo;s reserves
                  live in the basket contract, not in the pool: on every swap the hook mints or
                  redeems against reserves via <IC>beforeSwapReturnDelta</IC>, so the curve and its
                  in-range liquidity (permanently zero) are never used. Price the token from{' '}
                  <IC>exchangeRate()</IC> or the aggregate-spot reconstruction; routing details live
                  on the integration page.
                </InfoPop>
              </p>
            </Callout>
          </DocSection>

          {/* 3 */}
          <DocSection id="recon" className={hide('recon')} n="03" title="Aggregate-spot cross-check / fallback">
            <p>
              Reconstruct the value from holdings plus your own price source. Publish a divergence
              warning when this and the on-chain view disagree by more than ~2%, that gap is signal,
              not noise. Historical NAV still has no on-chain source; charts are reconstructed from
              per-asset price series.
            </p>
            <CodeBlock tone="bright" code={RECON} title="pseudocode" />
            <ul className="space-y-2.5">
              <li className="flex gap-2"><span className="text-cyan">·</span><span><strong className="text-ink">Live weight</strong> of constituent <IC>i</IC> = <IC>(held_i × price_i) / AUM</IC>.</span></li>
              <li className="flex gap-2"><span className="text-cyan">·</span><span><strong className="text-ink">24h change</strong> = value-weighted sum of each priced constituent&rsquo;s 24h change.</span></li>
              <li className="flex gap-2"><span className="text-cyan">·</span><span>Leave a constituent unpriced rather than assuming $0; surface <IC>pricedCount / totalCount</IC>.</span></li>
            </ul>
          </DocSection>

          {/* 4 */}
          <DocSection id="fees" className={hide('fees')} n="04" title="Per-basket fees: never hardcode a split">
            <p>
              Fees vary per basket and are immutable from launch. There is no universal split to
              print. Read each basket&rsquo;s config and the protocol constants:
            </p>
            <CodeBlock tone="bright" code={FEE_ABI} title="fee readout · V2" />
            {/* The "pool mint/redeem fees" qualifier is load-bearing: the in-kind
                exit's haircut accrues to remaining holders and never feeds the burn. */}
            <p>
              The burn share is a fixed protocol constant (<IC>BURN_SHARE_BPS</IC> = 10%): every basket
              routes exactly that share of its pool mint/redeem fees to an autonomous PRISM buy-and-burn
              path, uniform on every basket, with no per-basket dial and no ratchet. (The
              in-kind exit&rsquo;s haircut is the one exception, it stays in reserve for remaining holders.)
            </p>
          </DocSection>

          {/* 5 */}
          <DocSection id="hookdata" className={hide('hookdata')} n="05" title="hookData / legMins encoding">
            <CodeBlock tone="bright" code={HOOKDATA} title="mint/redeem hookData · v3" />
            <Callout variant="key" title="The first mint stays protected">
              <p>
                Empty hookData is accepted on launched baskets (v3, which is what lets generic
                aggregators and the canonical v4 router fill baskets with no adapter; see{' '}
                <Link className="text-cyan press" to="/integrate">the integration guide</Link>). The
                first mint of a new basket still hard-requires the tagged payload: derive{' '}
                <IC>legMins</IC> from live per-leg quotes at sign time: an interface that encodes
                zeros there removes the only slippage protection the share basis gets.
              </p>
            </Callout>
          </DocSection>

          {/* 6 */}
          <DocSection id="exit" className={hide('exit')} n="06" title="In-kind redemption: the unconditional exit">
            <CodeBlock tone="bright" code={REDEEM_IN_KIND} title="redeemInKind · V2" />
            <p>
              This is a mechanical contract swap, stated here as mechanics: outputs are deterministic
              pro-rata amounts of the constituent tokens themselves.
            </p>
          </DocSection>

          {/* 7 */}
          <DocSection id="discover" className={hide('discover')} n="07" title="Discovering baskets">
            <p>
              V2 adds keyless enumeration, a plain public RPC lists every basket with two view calls.
              No log scanning, no archive node, no API key.
            </p>
            <CodeBlock tone="bright" code={DISCOVERY} title="factory enumeration · V2" />
          </DocSection>

          {/* 8 */}
          <DocSection id="direct" className={hide('direct')} n="08" title="Direct contract access">
            <p>
              Every operation, mint, redeem, in-kind redemption, fee claim, enumeration, every read,
              works by calling the contracts directly, without any frontend. Any interface (including
              this one) can disappear or delist anything; the contracts do not care. If you integrate,
              integrate against the contracts, not against any website.
            </p>
          </DocSection>

          {/* 9 */}
          <DocSection id="gotchas" className={hide('gotchas')} n="09" title="Gotchas checklist">
            <Checklist
              items={[
                <span>Basket token is 18 decimals; USDC is 6; constituents vary, read per-entry <IC>decimals</IC>.</span>,
                <span>Denominator is <IC>effectiveSupply()</IC>, not <IC>totalSupply()</IC>.</span>,
                <span>Held amount is <IC>idleHeld(asset)</IC> (tracked, donation-immune), not <IC>balanceOf</IC>.</span>,
                <span>Check the <IC>fullyPriced</IC> flag on every static NAV read.</span>,
                <span>Cross-check on-chain NAV against aggregate-spot; surface &gt;2% divergence.</span>,
                <span>Never price the basket from its own self-pool.</span>,
                <span>Never print a universal fee split, read <IC>basketFeeBps()</IC> per basket.</span>,
                <span>Never encode empty/zero <IC>legMins</IC> in hookData.</span>,
                <span>Weights from <IC>basket()</IC> are <em className="not-italic text-ink">targets</em> in BPS; compute live weights from value.</span>,
              ]}
            />
          </DocSection>

          {/* 10 */}
          <DocSection id="addresses" className={hide('addresses')} n="10" title="Addresses">
            <p>
              Addresses come exclusively from this build&rsquo;s <IC>deployments.json</IC> / env
              config (see <IC>OPERATORS.md</IC>): what renders below is what this
              deployment is wired to. Nothing else ships; there are deliberately no v1 addresses
              anywhere, and a build with no deployment configured shows nothing here.
            </p>
            <div className="space-y-3">
              <AddrChips label="Factory" get={(c) => c.factory} />
              <AddrChips label="v4 PoolManager" get={(c) => c.poolManager} />
              <AddrChips label="v4 Quoter" get={(c) => c.v4Quoter} />
              <AddrChips label="Universal Router" get={(c) => c.universalRouter} />
            </div>
            <Callout variant="warn" title="Verify, then trust">
              <p>
                Re-verify every address on-chain before relying on it, including the canonical v4
                periphery against Uniswap&rsquo;s published deployments. A token the factory does
                not know (<IC>tokens(basket) == 0</IC>) is not a Spectrum basket.
              </p>
            </Callout>
          </DocSection>

          {/* 11 */}
          <DocSection id="indexing" className={hide('indexing')} n="11" title="Indexing: events and topic0s">
            <p>
              Everything an indexer subscribes to, with the topic0 hashes computed from the shipped
              ABI at render (they cannot drift from what this app transacts through). Full event
              signatures matter: a shortened signature hashes to a different topic0.
            </p>
            <IndexingReference />
            <p className="border-t border-white/10 pt-5 text-[12px] leading-relaxed text-ink-faint">
              △ <span className="text-ink-dim">SPECTRUM</span> · onchain baskets. This page defines the
              integration surface against the shipped V2 ABI (<IC>src/lib/spectrum/abis-v2.ts</IC>);
              re-verify signatures and addresses on-chain before relying on them.
            </p>
          </DocSection>

          {dq.trim() && hiddenIds.size === TOC.length && (
            <div className="rounded-2xl border border-dashed border-white/10 p-10 text-center text-sm text-ink-faint">
              Nothing in the docs mentions “{dq.trim()}”.
            </div>
          )}
        </article>
      </div>
      </div>
    </div>
  )
}
