import { lazy, Suspense, useEffect, type ReactElement } from 'react'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigationType } from 'react-router'
import { config } from './wagmi'
import { Layout } from './components/Layout'
import { captureRefFromUrl } from './lib/spectrum/referral'
import brand from './brand.config'
import { checkHandle } from './lib/spectrum/creator-handles'
import { pageEnabled, setupStudioEnabled, type PageKey } from './theme/brand'
import { DecorativeBoundary } from './components/DecorativeBoundary'
import { RouteErrorBoundary } from './components/ErrorBoundary'
import { CREATE_FLOW } from './lib/config/features'
import { SpecterWidget } from './components/chat/SpecterWidget'

// Route-level page toggle (default-on): a disabled page redirects to Home so a stale
// or shared URL never lands on a page the operator turned off. Nav hides the link too.
const gate = (key: PageKey, el: ReactElement): ReactElement =>
  pageEnabled(brand.pages, key) ? el : <Navigate to="/" replace />

// THE CREATE FLOW's own gate. It ships OFF (brand.config) because the engine is
// still SIMULATED — an operator must not serve it to real visitors — but every
// DEV server shows it, so :5309/:5311/:5313 keep working with zero source
// divergence between branches. Same idiom as Nav's LEAGUE_ANYWHERE.
// This is what let the flow converge onto the release line early: the code is
// here, one Home.tsx and one route table, and the toggle keeps it dark.
// The definition moved to lib/config/features.ts (owner 1826 added entry points
// in Nav/Token/Explore, which cannot import the router root); re-exported here
// for the existing importers.
export { CREATE_FLOW }

// Routes are code-split: each page (and its heavy deps — Recharts, the launch
// builder, the docs) loads on demand, keeping the initial bundle lean.
// THE HOMEPAGE (owner 2026-08-02): rebuilt around the proposition — manage
// first, publish as the graduation. The previous page (pages/Home.tsx) led with
// baskets, which sold the second half of the story first; it stays in the tree
// until this has had a round of his eyes on it.
const Home = lazy(() => import('./pages/HomeSpine').then((m) => ({ default: m.HomeSpine })))
const Explore = lazy(() => import('./pages/Explore').then((m) => ({ default: m.Explore })))
const SlashCreators = lazy(() => import('./pages/SlashCreators').then((m) => ({ default: m.SlashCreators })))
const CreatorsExplore = lazy(() => import('./pages/CreatorsExplore').then((m) => ({ default: m.CreatorsExplore })))
const Token = lazy(() => import('./pages/Token').then((m) => ({ default: m.Token })))
const Creator = lazy(() => import('./pages/Creator').then((m) => ({ default: m.Creator })))
// The /creator URL resolver: a claimed name OR an address (see the route below).
// Lazy like every other page module — it reaches the basket index and the notes
// reader, which must not sit in the first-paint bundle.
const CreatorRoute = lazy(() =>
  import('./components/creator/CreatorRoute').then((m) => ({ default: m.CreatorRoute })),
)
// One creator's cross-chain idea, read back as one product (see pages/Thesis.tsx).
const Thesis = lazy(() => import('./pages/Thesis').then((m) => ({ default: m.Thesis })))
const Portfolio = lazy(() => import('./pages/Portfolio').then((m) => ({ default: m.Portfolio })))
const Onboarding = lazy(() => import('./pages/Onboarding').then((m) => ({ default: m.Onboarding })))
const Yours = lazy(() => import('./pages/Yours').then((m) => ({ default: m.Yours })))
const OnboardingGate = lazy(() =>
  import('./components/portfolio/OnboardingGate').then((m) => ({ default: m.OnboardingGate })),
)
const Create = lazy(() => import('./pages/Create').then((m) => ({ default: m.Create })))
const Composer = lazy(() => import('./pages/Composer').then((m) => ({ default: m.Composer })))
const Setup = lazy(() => import('./pages/Setup').then((m) => ({ default: m.Setup })))
const Swap = lazy(() => import('./pages/Swap').then((m) => ({ default: m.Swap })))
// The agent chat: conversational reads + trades over the same money modules.
// Lazy for the mascot sprites and the embedded trade card's deps.
const Chat = lazy(() => import('./pages/Chat').then((m) => ({ default: m.Chat })))
const Flush = lazy(() => import('./pages/Flush').then((m) => ({ default: m.Flush })))
const Embed = lazy(() => import('./pages/Embed').then((m) => ({ default: m.Embed })))
const ExtensionPage = lazy(() => import('./pages/Extension').then((m) => ({ default: m.ExtensionPage })))
const Learn = lazy(() => import('./pages/Learn').then((m) => ({ default: m.Learn })))
const Docs = lazy(() => import('./pages/Docs').then((m) => ({ default: m.Docs })))
const Mcp = lazy(() => import('./pages/Mcp').then((m) => ({ default: m.Mcp })))
const Integrate = lazy(() => import('./pages/Integrate').then((m) => ({ default: m.Integrate })))
const League = lazy(() => import('./pages/League').then((m) => ({ default: m.League })))
const Bundle = lazy(() => import('./pages/Bundle').then((m) => ({ default: m.Bundle })))
const PublishedBundlePage = lazy(() => import('./pages/Bundle').then((m) => ({ default: m.PublishedBundlePage })))
const BundleForgePage = lazy(() => import('./components/BundleForge').then((m) => ({ default: m.BundleForgePage })))
const Manager = lazy(() => import('./pages/Manager').then((m) => ({ default: m.Manager })))
const Refer = lazy(() => import('./pages/Refer').then((m) => ({ default: m.Refer })))
const PrismClaim = lazy(() => import('./pages/PrismClaim').then((m) => ({ default: m.PrismClaim })))
const Terms = lazy(() => import('./pages/Terms').then((m) => ({ default: m.Terms })))
const VerifyPage = lazy(() => import('./pages/Verify').then((m) => ({ default: m.Verify })))
const Privacy = lazy(() => import('./pages/Privacy').then((m) => ({ default: m.Privacy })))
const Risk = lazy(() => import('./pages/Risk').then((m) => ({ default: m.Risk })))
const NotFound = lazy(() => import('./pages/NotFound').then((m) => ({ default: m.NotFound })))
// The WebGL background is purely decorative + pulls in three.js (~heavy). Lazy-load
// it so it's off the first-paint critical path; a null fallback means the page just
// shows the solid void bg until it streams in.
const SpectrumBackground = lazy(() =>
  import('./components/SpectrumBackground').then((m) => ({ default: m.SpectrumBackground })),
)
const PostDeployTest = import.meta.env.DEV
  ? lazy(() => import('./pages/PostDeployTest').then((m) => ({ default: m.PostDeployTest })))
  : null
const BuySuccessTest = import.meta.env.DEV
  ? lazy(() => import('./pages/BuySuccessTest').then((m) => ({ default: m.BuySuccessTest })))
  : null

// THE READ BUDGET's floor (RPC audit, 2026-08-06): stock defaults mean
// staleTime 0 + refetchOnWindowFocus true — any query that forgot to set a
// staleTime refetches on EVERY tab focus. A 30s default caps that: a refocus
// re-reads only what is genuinely stale, which is also the measured budget
// for the freshness-whisper's focus-regain half (a settled portfolio costs
// ~46 upstream calls to fully re-read; stale-only refocus costs a fraction).
// Queries that declare their own staleTime keep it — this is the floor for
// the ones that never said.
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000 } },
})

// Per-route browser-tab titles. These are BRAND-DERIVED (kit audit): they used to
// hardcode "Spectrum", which silently defeated the build-time brandHtml plugin —
// that plugin exists so an operator's tab and social cards carry THEIR name, and
// the social half worked while this overwrote the tab one frame after hydration.
// The page label is the part before the separator; the suffix is the operator's.
const ROUTE_LABELS: Record<string, string> = {
  '/explore': 'Explore',
  '/creators/explore': 'Creators',
  '/creators': 'For creators',
  '/token': 'Basket',
  '/portfolio': 'Portfolio',
  '/onboarding': 'Get started',
  '/portfolio/classic': 'Portfolio (classic)',
  '/compose': 'Composer',
  '/createbasket': 'Create a Basket',
  '/swap': 'Swap',
  '/chat': 'Agent chat',
  '/flush': 'Fees',
  '/embed': 'Basket',
  '/learn': 'Learn',
  '/docs': 'Docs',
  '/mcp': 'Agents',
  '/docs/valuation': 'Docs',
  '/integrate': 'Route baskets',
  '/earn': 'Earn',
  '/league': 'Creator league',
  '/bundle': 'Bundles',
  '/bundle/new': 'New bundle',
  '/create': 'Create',
  '/claim': 'PRISM claim',
  '/terms': 'Terms',
  '/verify': 'Verify contracts',
  '/privacy': 'Privacy',
  '/risk': 'Risk',
}

/** The home/fallback title — mirrors what brandHtml writes into index.html. */
const homeTitle = () => `${brand.name} · ${brand.tagline?.trim() || 'onchain baskets'}`

function RouteTitle() {
  const { pathname, search } = useLocation()
  useEffect(() => {
    // Exact match first, then the parameterised shapes. The short routes are
    // prefixes, so they can never be exact-matched from the table above.
    // Named shapes title with the NAME (QOL 2026-08-06): /creator/basedresearch
    // reads "basedresearch", /t/r/T2-… reads "$T2" — the tab and the history
    // carry the identity, not the category. Pure pathname parses, both bounded:
    // a creator segment titles only when it passes checkHandle (charset + ≤30
    // by claim law), a short-link symbol only through its own SAFE shape.
    const seg = (prefix: string) => {
      if (!pathname.startsWith(prefix)) return null
      return pathname.slice(prefix.length).split('/')[0] || null
    }
    const creatorSeg = seg('/creator/') ?? seg('/c/')
    const creatorName = creatorSeg && !creatorSeg.startsWith('0x') ? checkHandle(creatorSeg) : null
    const shortRef = pathname.startsWith('/t/') ? (pathname.split('/').pop() ?? '') : ''
    const shortSym = /^([A-Za-z0-9]{1,11})-[0-9a-fA-F]{4,}$/.exec(shortRef)?.[1] ?? null
    const label =
      ROUTE_LABELS[pathname] ??
      (creatorName?.ok
        ? creatorName.handle.display
        : pathname.startsWith('/creator') || pathname.startsWith('/c/')
          ? 'Creator'
          : shortSym
            ? `$${shortSym.toUpperCase()}`
            : pathname.startsWith('/t/')
              ? 'Basket'
              : pathname.startsWith('/b/')
                ? 'Bundle'
                : pathname.startsWith('/thesis/')
                  ? 'Thesis'
                  : null)
    document.title = label ? `${label} · ${brand.name}` : homeTitle()
  }, [pathname])
  // Scroll to the top on every navigation. pushState does NOT move the scroll
  // position, so without this you arrive on the new page at the offset you left
  // the old one at: click a basket from 3000px down Explore and the token page
  // renders mid-fee-table, title off-screen. It fired on every route change for
  // every user and nothing in the router handled it.
  //
  // The hash guard is load-bearing: Learn and Docs navigate to in-page anchors
  // (#nav, #fees), and scrolling to 0 would defeat exactly those links.
  //
  // POP is exempt because a back/forward is a RETURN, not an arrival: the
  // browser has already restored the offset that history entry was left at, and
  // scrolling to 0 on top of that threw the place away every time — read far
  // down Explore, open a basket, press Back, and you were at the top of the
  // catalogue instead of on the card you tapped. A genuine forward navigation
  // (PUSH/REPLACE) has no restored position, so it still goes to the top.
  const { hash } = useLocation()
  const navType = useNavigationType()
  useEffect(() => {
    if (!hash && navType !== 'POP') window.scrollTo(0, 0)
  }, [pathname, hash, navType])
  // Capture a `?ref=<address>` from any inbound link and persist it (FIRST-touch —
  // the original referrer wins and is never overwritten; see referral.ts), so the
  // money paths can tag the referrer (owner 2026-07-07). Read-only here.
  useEffect(() => {
    void captureRefFromUrl(search)
  }, [search])
  return null
}

/** /launch → /create, carrying the query. `?from=…&chain=…` is the migration
 *  system's seam (old version-door links), and a plain <Navigate to="/create">
 *  would drop it — the studio would open fresh instead of in version mode. */
function LaunchRedirect() {
  const { search, hash } = useLocation()
  return <Navigate to={{ pathname: '/create', search, hash }} replace />
}

function RouteFallback() {
  return (
    <div className="grid min-h-[60vh] place-items-center" aria-label="Loading" role="status">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/15 border-t-cyan" />
    </div>
  )
}

// The animated band canvas, gated off /embed: embeds render chrome-less inside
// THIRD-PARTY iframes (Layout bypasses all chrome there), and since the bands
// moved to the foreground (z-40) the canvas would paint animated glow over the
// host page's card — and burn WebGL in every embed (audit).
function AmbientBackground() {
  const { pathname } = useLocation()
  if (pathname.startsWith('/embed')) return null
  // BOUNDARY IS LOAD-BEARING, not belt-and-braces. SpectrumBackground builds a
  // three.js WebGLRenderer, which throws "Error creating WebGL context" on any
  // client that cannot provide one. Mounted bare at the app root, that throw
  // unmounted the WHOLE tree — #root with zero children, a blank site caused by
  // a decoration. Verified by driving a GPU-less browser at the dev server.
  return (
    <DecorativeBoundary>
      <SpectrumBackground />
    </DecorativeBoundary>
  )
}

export function App() {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <RouteTitle />
          <Suspense fallback={null}>
            <AmbientBackground />
          </Suspense>
          <Layout>
            {/* INSIDE Layout, around the routes only (QOL round 2026-08-05, item
                12): a throw in one card degrades to a page-shaped error while the
                nav, banners and footer stay up, so a visitor can always leave.
                Wrapped at this level rather than the app root for exactly that
                reason — a single boundary over everything would take the chrome
                down with the page and leave no way out but the URL bar.
                OUTSIDE the Suspense so a failed lazy chunk (a stale deploy, a
                dropped connection mid-navigation) lands on the same honest panel
                instead of spinning forever. See components/ErrorBoundary.tsx. */}
            <RouteErrorBoundary>
              <Suspense fallback={<RouteFallback />}>
                <Routes>
                  <Route path="/" element={<Home />} />
                  <Route path="/explore" element={gate('discover', <Explore />)} />
                  {/* Slash Creators — the KOL/creator funnel + embedded launch flow
                      (reclaims /creators, owner call 2026-07-06). */}
                  <Route path="/creators" element={gate('creators', <SlashCreators />)} />
                  {/* the creators DISCOVERY page — one creator per row, their
                      thesis + performance + a carousel of their baskets (owner
                      2026-08-21). Distinct from /creators (the become-a-creator
                      funnel) and /explore (the basket catalogue). Rides the
                      same 'discover' gate as /explore — it is discovery. */}
                  <Route path="/creators/explore" element={gate('discover', <CreatorsExplore />)} />
                  <Route path="/token" element={<Token />} />
                  {/* /creator/:idOrHandle (claimable creator names, spec
                      workspace/spectrum-release/creator-handles-spec.md). ONE
                      route serving both: the wrapper resolves a claimed name to
                      its owner and hands the page the same `:address` param it
                      has always read, so pages/Creator.tsx is untouched. The
                      ADDRESS form takes no lookup and cannot break — every
                      /creator/0x… link already in the wild keeps working. */}
                  <Route path="/creator/*" element={<CreatorRoute base="/creator" element={<Creator />} />} />
                  {/* /thesis/:deployer/:slug — the several baskets one create
                      session shipped across chains, shown as the ONE idea they
                      were (lib/spectrum/thesis.ts recognises the group; the
                      slug is its name, lib/spectrum/thesis-url.ts).
                      UNGATED, like /creator above: it is a re-view of that
                      creator's own baskets, so riding a page toggle it does not
                      own would be inventing operator policy. Two segments deep,
                      so public/_redirects carries its asset rewrite. */}
                  <Route path="/thesis/:deployer/:slug" element={<Thesis />} />
                  {/* SHORT LINKS (owner 2026-08-01). Additive, never a rename:
                      every URL above keeps resolving forever because they are
                      already shared publicly. These are simply what the app mints
                      from now on. See lib/spectrum/short-url.ts. */}
                  <Route path="/t/:chain/:ref" element={<Token />} />
                  <Route path="/c/*" element={<CreatorRoute base="/c" element={<Creator />} />} />
                  <Route path="/b/:creator/:slug" element={gate('bundle', <PublishedBundlePage />)} />
                  {/* The reworked portfolio (the owner 2026-08-02: "park the old
                      page and recreate a new one") — the classic page stays
                      reachable while fees/claims migrate. */}
                  {/* First-open ceremony rides the ROUTE, not the page: Yours carries zero
                      intro code, so the allocator lane's rework merges clean. The frame
                      holds the page soft behind the veil and surfaces it on reveal. */}
                  <Route
                    path="/portfolio"
                    element={gate(
                      'portfolio',
                      <OnboardingGate>
                        <Yours />
                      </OnboardingGate>,
                    )}
                  />
                  <Route path="/portfolio/classic" element={gate('portfolio', <Portfolio />)} />
                  {/* The PUBLIC onboarding funnel (owner 2026-08-06): a shareable
                      landing that pitches the portfolio and connects a wallet in
                      place. Rides the portfolio toggle — onboarding INTO a page
                      an operator turned off would be a door to nowhere. */}
                  <Route path="/onboarding" element={gate('portfolio', <Onboarding />)} />
                  {/* /create IS the creation route (owner 2026-08-12: "/launch
                      needs to be replaced with /create for the basket migration
                      system and creating a basket/bundle") — the Composer face
                      bare; the full studio under ?from (version/migration mode)
                      or ?studio=1. It rides the launch page key because it is
                      the REAL money path; CREATE_FLOW keeps gating only the
                      simulated manager engine, which now lives at /manager. */}
                  <Route path="/create" element={gate('launch', <Create />)} />
                  <Route path="/manager" element={CREATE_FLOW ? <Manager /> : <Navigate to="/" replace />} />
                  {/* Old links and bookmarks keep working; nothing advertises it. */}
                  <Route path="/launch" element={<LaunchRedirect />} />
                  <Route path="/compose" element={gate('launch', <Composer />)} />
                  {/* Stable external contract for the Prismbeat bot's /createbasket
                      deep-link (?tokens=&chain=) — renders the Composer, which
                      pre-fills + hands off to the real signed launch flow. */}
                  <Route path="/createbasket" element={gate('launch', <Composer />)} />
                  {/* Cross-chain ALLOCATIONS — several single-chain baskets held as one
                      allocation (revived 2026-07-29; hidden 07-09). NOT one token. */}
                  <Route path="/bundle" element={gate('bundle', <Bundle />)} />
                  {/* THE FORGE. One segment, so it never collides with the
                      two-segment :creator/:slug pattern below. `?from=&chain=`
                      seeds a leg — that is the Token page's one-tap entry. */}
                  <Route path="/bundle/new" element={gate('bundle', <BundleForgePage />)} />
                  {/* a PUBLISHED bundle's own page — stable + shareable, reads the
                      on-chain note so it survives the share link being lost */}
                  <Route path="/bundle/:creator/:slug" element={gate('bundle', <PublishedBundlePage />)} />
                  <Route path="/swap" element={gate('trade', <Swap />)} />
                  {/* the agent chat rides the trade toggle: it embeds the same
                      trade card, so an operator who turned trading off must not
                      serve a chat that brings it back */}
                  <Route path="/chat" element={gate('trade', <Chat />)} />
                  <Route path="/flush" element={gate('fees', <Flush />)} />
                  {/* The extension install surface — renders from the packaging
                      step's /extension/index.json (static files win over this
                      route; the bare path has no file, so the SPA serves the
                      page). Self-explains when nothing is packaged yet. */}
                  <Route path="/extension" element={<ExtensionPage />} />
                  {/* chrome-less (Layout bypasses for /embed) — the iframe-able card */}
                  <Route path="/embed" element={<Embed />} />
                  {/* On-site Setup studio — live design customizer → exports brand.config.ts.
                      Always served in dev; on production builds `brand.setupStudio: false`
                      locks it out (default ON). */}
                  {setupStudioEnabled(brand) && <Route path="/setup" element={<Setup />} />}
                  {/* /faq merged INTO /learn (owner 2026-08-01, the simplification):
                      ONE surface for a person, one for an integrator. The route stays
                      as a redirect — it is linked from outside the app, and a dead
                      /faq is a worse outcome than one extra line here. */}
                  <Route path="/faq" element={gate('docs', <Navigate to="/learn" replace />)} />
                  <Route path="/learn" element={gate('docs', <Learn />)} />
                  {/* the agent surface: part pitch, part reference (owner 2026-08-19) */}
                  <Route path="/mcp" element={gate('docs', <Mcp />)} />
                  <Route path="/docs" element={gate('docs', <Docs />)} />
                  {/* /docs/valuation was never a second page — same component. It stays
                      for the links already in the wild; in-app links now use /docs#nav. */}
                  <Route path="/docs/valuation" element={gate('docs', <Docs />)} />
                  {/* aggregator / solver / bot integration guide (one BD-linkable URL) */}
                  <Route path="/integrate" element={gate('integrate', <Integrate />)} />
                  <Route path="/earn" element={gate('refer', <Refer />)} />
                  {/* the old path lives on as a redirect — shared links keep working */}
                  <Route path="/refer" element={<Navigate to="/earn" replace />} />
                  <Route path="/league" element={gate('league', <League />)} />
                  <Route path="/claim" element={gate('claim', <PrismClaim />)} />
                  <Route path="/terms" element={<Terms />} />
                  <Route path="/verify" element={<VerifyPage />} />
                  <Route path="/privacy" element={<Privacy />} />
                  <Route path="/risk" element={<Risk />} />
                  {/* Dev-only harness (reproduces the deploy ceremony + a MOCK "Buy" bar).
                      Never routed in production builds, so the public site has no buy path here. */}
                  {import.meta.env.DEV && PostDeployTest && (
                    <Route path="/post-deploy-test" element={<PostDeployTest />} />
                  )}
                  {import.meta.env.DEV && BuySuccessTest && (
                    <Route path="/buy-success-test" element={<BuySuccessTest />} />
                  )}
                  {/* catch-all — unknown / stale URLs get a branded 404, not a blank page */}
                  <Route path="*" element={<NotFound />} />
                </Routes>
              </Suspense>
            </RouteErrorBoundary>
          </Layout>
          {/* the site-wide Specter (owner 2026-08-20): mounted OUTSIDE the
              route wrapper — its lg translate makes a transformed ancestor,
              which would re-scope the widget's position:fixed (the backdrop
              lesson). Hides itself on /chat and /embed. */}
          <SpecterWidget />
        </BrowserRouter>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
