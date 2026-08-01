import { lazy, Suspense, useEffect, type ReactElement } from 'react'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { config } from './wagmi'
import { Layout } from './components/Layout'
import { captureRefFromUrl } from './lib/spectrum/referral'
import brand from './brand.config'
import { pageEnabled, setupStudioEnabled, type PageKey } from './theme/brand'

// Route-level page toggle (default-on): a disabled page redirects to Home so a stale
// or shared URL never lands on a page the operator turned off. Nav hides the link too.
const gate = (key: PageKey, el: ReactElement): ReactElement =>
  pageEnabled(brand.pages, key) ? el : <Navigate to="/" replace />

// Routes are code-split: each page (and its heavy deps — Recharts, the launch
// builder, the docs) loads on demand, keeping the initial bundle lean.
const Home = lazy(() => import('./pages/Home').then((m) => ({ default: m.Home })))
const Explore = lazy(() => import('./pages/Explore').then((m) => ({ default: m.Explore })))
const SlashCreators = lazy(() => import('./pages/SlashCreators').then((m) => ({ default: m.SlashCreators })))
const Token = lazy(() => import('./pages/Token').then((m) => ({ default: m.Token })))
const Creator = lazy(() => import('./pages/Creator').then((m) => ({ default: m.Creator })))
const Portfolio = lazy(() => import('./pages/Portfolio').then((m) => ({ default: m.Portfolio })))
const Launch = lazy(() => import('./pages/Launch').then((m) => ({ default: m.Launch })))
const Composer = lazy(() => import('./pages/Composer').then((m) => ({ default: m.Composer })))
const Setup = lazy(() => import('./pages/Setup').then((m) => ({ default: m.Setup })))
const Swap = lazy(() => import('./pages/Swap').then((m) => ({ default: m.Swap })))
const Flush = lazy(() => import('./pages/Flush').then((m) => ({ default: m.Flush })))
const Embed = lazy(() => import('./pages/Embed').then((m) => ({ default: m.Embed })))
const Faq = lazy(() => import('./pages/Faq').then((m) => ({ default: m.Faq })))
const Learn = lazy(() => import('./pages/Learn').then((m) => ({ default: m.Learn })))
const Docs = lazy(() => import('./pages/Docs').then((m) => ({ default: m.Docs })))
const Integrate = lazy(() => import('./pages/Integrate').then((m) => ({ default: m.Integrate })))
const League = lazy(() => import('./pages/League').then((m) => ({ default: m.League })))
const Bundle = lazy(() => import('./pages/Bundle').then((m) => ({ default: m.Bundle })))
const PublishedBundlePage = lazy(() => import('./pages/Bundle').then((m) => ({ default: m.PublishedBundlePage })))
const BundleForgePage = lazy(() => import('./components/BundleForge').then((m) => ({ default: m.BundleForgePage })))
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

const queryClient = new QueryClient()

// Per-route browser-tab titles. These are BRAND-DERIVED (kit audit): they used to
// hardcode "Spectrum", which silently defeated the build-time brandHtml plugin —
// that plugin exists so an operator's tab and social cards carry THEIR name, and
// the social half worked while this overwrote the tab one frame after hydration.
// The page label is the part before the separator; the suffix is the operator's.
const ROUTE_LABELS: Record<string, string> = {
  '/explore': 'Explore',
  '/creators': 'For creators',
  '/token': 'Basket',
  '/portfolio': 'Portfolio',
  '/launch': 'Launch a Basket',
  '/compose': 'Composer',
  '/createbasket': 'Create a Basket',
  '/swap': 'Swap',
  '/flush': 'Fees & cranks',
  '/embed': 'Basket',
  '/faq': 'FAQ',
  '/learn': 'Learn',
  '/docs': 'Docs',
  '/docs/valuation': 'Valuation docs',
  '/integrate': 'Route baskets',
  '/earn': 'Earn',
  '/league': 'Creator league',
  '/bundle': 'Bundles',
  '/bundle/new': 'New bundle',
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
    const label =
      ROUTE_LABELS[pathname] ??
      (pathname.startsWith('/creator') || pathname.startsWith('/c/')
        ? 'Creator'
        : pathname.startsWith('/t/')
          ? 'Basket'
          : pathname.startsWith('/b/')
            ? 'Bundle'
            : null)
    document.title = label ? `${label} · ${brand.name}` : homeTitle()
  }, [pathname])
  // Capture a `?ref=<address>` from any inbound link and persist it (FIRST-touch —
  // the original referrer wins and is never overwritten; see referral.ts), so the
  // money paths can tag the referrer (owner 2026-07-07). Read-only here.
  useEffect(() => {
    void captureRefFromUrl(search)
  }, [search])
  return null
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
  return <SpectrumBackground />
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
            <Suspense fallback={<RouteFallback />}>
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/explore" element={gate('discover', <Explore />)} />
                {/* Slash Creators — the KOL/creator funnel + embedded launch flow
                    (reclaims /creators, owner call 2026-07-06). */}
                <Route path="/creators" element={gate('creators', <SlashCreators />)} />
                <Route path="/token" element={<Token />} />
                <Route path="/creator/:address" element={<Creator />} />
                {/* SHORT LINKS (owner 2026-08-01). Additive, never a rename:
                    every URL above keeps resolving forever because they are
                    already shared publicly. These are simply what the app mints
                    from now on. See lib/spectrum/short-url.ts. */}
                <Route path="/t/:chain/:ref" element={<Token />} />
                <Route path="/c/:address" element={<Creator />} />
                <Route path="/b/:creator/:slug" element={gate('bundle', <PublishedBundlePage />)} />
                <Route path="/portfolio" element={gate('portfolio', <Portfolio />)} />
                <Route path="/launch" element={gate('launch', <Launch />)} />
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
                <Route path="/flush" element={gate('fees', <Flush />)} />
                {/* chrome-less (Layout bypasses for /embed) — the iframe-able card */}
                <Route path="/embed" element={<Embed />} />
                {/* On-site Setup studio — live design customizer → exports brand.config.ts.
                    Always served in dev; on production builds `brand.setupStudio: false`
                    locks it out (default ON). */}
                {setupStudioEnabled(brand) && <Route path="/setup" element={<Setup />} />}
                <Route path="/faq" element={gate('docs', <Faq />)} />
                <Route path="/learn" element={gate('docs', <Learn />)} />
                <Route path="/docs" element={gate('docs', <Docs />)} />
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
          </Layout>
        </BrowserRouter>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
