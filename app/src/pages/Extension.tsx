import { useQuery } from '@tanstack/react-query'
import { brand } from '../brand.config'
import { InfoDot } from '../components/InfoDot'

// ─────────────────────────────────────────────────────────────────────────────
// /extension — the install surface for THIS SITE's browser extension (the
// portfolio lens). Renders from /extension/index.json, which the packaging
// step (extension/scripts/package.mjs --into-site) writes beside the zips, so
// the site itself hosts its own extension downloads.
//
// Honesty laws of this page:
//  · A WEBSITE CANNOT INSTALL AN EXTENSION (Chrome removed inline install in
//    2018). The honest ceiling is one click plus the browser's own
//    confirmation — the copy never implies more.
//  · This page is the anti-impersonation anchor: it states that this exact
//    URL is the only official source and that the lens never asks for a seed
//    phrase or a signature.
//  · Not packaged → say so plainly; never a dead download button.
// ─────────────────────────────────────────────────────────────────────────────

interface ExtensionIndex {
  name: string
  version: string
  chrome: string | null
  firefox: string | null
  xpi: string | null
}

function useExtensionIndex() {
  return useQuery<ExtensionIndex | null>({
    queryKey: ['extension', 'index'],
    staleTime: 10 * 60_000,
    retry: 1,
    queryFn: async () => {
      // A network failure THROWS (isError → "couldn't check" copy) — only a
      // definitive answer may say "not packaged". An SPA rewrite serves
      // index.html for missing files, so a 200 that isn't JSON IS definitive.
      const res = await fetch('/extension/index.json', { headers: { Accept: 'application/json' } })
      if (!res.ok) return null
      const text = await res.text()
      try {
        const parsed = JSON.parse(text) as ExtensionIndex
        return typeof parsed?.version === 'string' ? parsed : null
      } catch {
        return null
      }
    },
  })
}

const isFirefox = typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent)

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col rounded-2xl border border-white/12 bg-white/[0.03] p-6">
      <h2 className="font-display text-base font-bold uppercase tracking-[0.08em] text-ink">{title}</h2>
      {children}
    </div>
  )
}

const btnPrimary =
  'press mt-5 inline-flex h-11 items-center justify-center rounded-full px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-void'
const btnQuiet =
  'press mt-5 inline-flex h-11 items-center justify-center rounded-full border border-white/15 px-6 font-mono text-[11px] uppercase tracking-[0.12em] text-ink-dim hover:border-cyan/50 hover:text-cyan'
const SPECTRAL = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'

export function ExtensionPage() {
  const { data: idx, isLoading, isError } = useExtensionIndex()
  const storeUrl = brand.extensionStoreUrl

  return (
    <div className="mx-auto max-w-[760px] py-10">
      <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink-dim">browser extension</p>
      <h1 className="mt-2 font-display text-4xl font-bold uppercase tracking-tight text-ink">
        {brand.name} <span className="text-ink-dim">Lens</span>
      </h1>
      <p className="mt-4 max-w-[52ch] text-[13px] leading-relaxed text-ink-dim">
        A read-only lens over what you hold, in your browser toolbar. It watches your baskets
        while the browser is open and hands off to this site to act.
        <InfoDot>
          It never connects to your wallet, never signs, and never asks for a seed phrase. Alerts
          are checked every few minutes while your browser is open, not in real time. Acting on
          anything always happens here, on the site, with your own wallet.
        </InfoDot>
      </p>

      {isLoading ? (
        <div className="mt-8 h-40 animate-pulse rounded-2xl bg-white/[0.04]" role="status" aria-label="Loading" />
      ) : isError ? (
        <div className="mt-8 rounded-2xl border border-white/12 bg-white/[0.03] p-6">
          <p className="font-mono text-[11px] uppercase tracking-widest text-ink-faint">
            couldn&rsquo;t check the extension listing right now, try a refresh
          </p>
        </div>
      ) : !idx ? (
        <div className="mt-8 rounded-2xl border border-white/12 bg-white/[0.03] p-6">
          <p className="font-mono text-[11px] uppercase tracking-widest text-ink-faint">
            this site doesn&rsquo;t host its extension yet
          </p>
          {import.meta.env.DEV && (
            <p className="mt-3 text-[12px] leading-relaxed text-ink-dim">
              Operator note (dev builds only): package it with{' '}
              <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[11px]">
                cd extension &amp;&amp; npm install &amp;&amp; npm run package -- --into-site
              </code>{' '}
              then rebuild the site. The walkthrough lives in the /setup studio&rsquo;s Extension
              panel.
            </p>
          )}
        </div>
      ) : (
        <>
          {/* the visitor's own browser leads by REAL DOM ORDER — reading and
              tab order match the visual order on every breakpoint */}
          <div className="mt-8 grid gap-4 md:grid-cols-2">
            {(() => {
              const chromeCard = (
                <div>
                  <Card title="Chrome · Brave · Edge">
                    <p className="mt-2 flex-1 text-[12px] leading-relaxed text-ink-dim">
                      {storeUrl
                        ? 'One click on the store listing, then your browser asks to confirm.'
                        : 'Download the file this site hosts, then load it in your browser. Three steps, no store account needed.'}
                    </p>
                    {storeUrl ? (
                      <a href={storeUrl} target="_blank" rel="noopener noreferrer" className={btnPrimary} style={{ background: SPECTRAL }}>
                        Get it on the Chrome Web Store ↗
                      </a>
                    ) : idx.chrome ? (
                      <>
                        <a href={`/extension/${idx.chrome}`} download className={btnPrimary} style={{ background: SPECTRAL }}>
                          Download for Chrome
                        </a>
                        <ol className="mt-4 space-y-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-faint">
                          <li>1 · unzip the download</li>
                          <li>2 · open chrome://extensions and turn on Developer mode</li>
                          <li>3 · click Load unpacked and pick the folder</li>
                        </ol>
                      </>
                    ) : (
                      <p className="mt-4 font-mono text-[10px] uppercase tracking-widest text-ink-faint">no Chrome build packaged</p>
                    )}
                  </Card>
                </div>
              )
              const firefoxCard = (
                <div>
                  <Card title="Firefox">
                    {idx.xpi ? (
                      <>
                        <p className="mt-2 flex-1 text-[12px] leading-relaxed text-ink-dim">
                          One click, then Firefox itself asks to confirm the install.
                        </p>
                        <a href={`/extension/${idx.xpi}`} className={btnPrimary} style={{ background: SPECTRAL }}>
                          Install for Firefox
                        </a>
                      </>
                    ) : idx.firefox ? (
                      <>
                        <p className="mt-2 flex-1 text-[12px] leading-relaxed text-ink-dim">
                          The one-click file isn&rsquo;t signed on this site yet. The zip works today
                          as a temporary add-on for developers; one-click install arrives once the
                          operator signs it.
                        </p>
                        <a href={`/extension/${idx.firefox}`} download className={btnQuiet}>
                          Download the Firefox zip
                        </a>
                      </>
                    ) : (
                      <p className="mt-2 flex-1 font-mono text-[10px] uppercase tracking-widest text-ink-faint">no Firefox build packaged</p>
                    )}
                  </Card>
                </div>
              )
              return isFirefox ? (<>{firefoxCard}{chromeCard}</>) : (<>{chromeCard}{firefoxCard}</>)
            })()}
          </div>

          <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.02] p-5">
            <p className="text-[12px] leading-relaxed text-ink-dim">
              <span className="font-display text-[11px] font-bold uppercase tracking-[0.1em] text-ink">The official source.</span>{' '}
              This page is the only place {brand.name} distributes its extension. Installing takes
              one click plus your browser&rsquo;s own confirmation, nothing more. The lens is
              read-only: it never connects, never signs, and never asks for a seed phrase, here or
              anywhere.
            </p>
            <p className="mt-2 font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">
              v{idx.version} · built for this site
            </p>
          </div>
        </>
      )}
    </div>
  )
}
