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
const Refer = lazy(() => import('./pages/Refer').then((m) => ({ default: m.Refer })))
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

// Per-route browser-tab titles (the static index.html title/OG is what social
// crawlers see; this just keeps the tab label in sync as you navigate).
const ROUTE_TITLES: Record<string, string> = {
  '/': 'Spectrum · onchain baskets',
  '/explore': 'Explore · Spectrum',
  '/creators': 'For creators · Spectrum',
  '/token': 'Basket · Spectrum',
  '/portfolio': 'Portfolio · Spectrum',
  '/launch': 'Launch a Basket · Spectrum',
  '/compose': 'Composer · Spectrum',
  '/createbasket': 'Create a Basket · Spectrum',
  '/swap': 'Swap · Spectrum',
  '/flush': 'Fees & cranks · Spectrum',
  '/embed': 'Basket · Spectrum',
  '/faq': 'FAQ · Spectrum',
  '/learn': 'Learn · Spectrum',
  '/docs': 'Docs · Spectrum',
  '/docs/valuation': 'Valuation docs · Spectrum',
  '/integrate': 'Route baskets · Spectrum',
  '/refer': 'Refer & earn · Spectrum',
  '/terms': 'Terms · Spectrum',
  '/verify': 'Verify contracts · Spectrum',
  '/privacy': 'Privacy · Spectrum',
  '/risk': 'Risk · Spectrum',
}

function RouteTitle() {
  const { pathname, search } = useLocation()
  useEffect(() => {
    document.title =
      ROUTE_TITLES[pathname] ??
      (pathname.startsWith('/creator') ? 'Creator · Spectrum' : 'Spectrum · onchain baskets')
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

export function App() {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <RouteTitle />
          <Suspense fallback={null}>
            <SpectrumBackground />
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
                <Route path="/portfolio" element={gate('portfolio', <Portfolio />)} />
                <Route path="/launch" element={gate('launch', <Launch />)} />
                <Route path="/compose" element={gate('launch', <Composer />)} />
                {/* Stable external contract for the Prismbeat bot's /createbasket
                    deep-link (?tokens=&chain=) — renders the Composer, which
                    pre-fills + hands off to the real signed launch flow. */}
                <Route path="/createbasket" element={gate('launch', <Composer />)} />
                {/* Cross-chain bundles (pages/Bundle.tsx) are HIDDEN for now — no route. */}
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
                <Route path="/refer" element={gate('refer', <Refer />)} />
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
