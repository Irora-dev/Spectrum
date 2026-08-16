import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { InfoDot } from '../InfoDot'

// ─────────────────────────────────────────────────────────────────────────────
// The /setup studio's Extension panel — renders ENTIRELY from the extension's
// own introspection contract (extension/scripts/status.mjs --json; keys are
// append-only). The dev server proxies it at /__setup/extension-status; a
// deployed static site has no endpoint, so the panel degrades to "run this
// locally". Commands are copyable, never executed from the page.
// ─────────────────────────────────────────────────────────────────────────────

interface ExtStatus {
  version: string | null
  name: string | null
  siteConfigured: boolean
  built: { chrome: boolean; firefox: boolean; firefoxGeckoId: string | null }
  packaged: { artifacts: string[]; intoSite: boolean; siteHosted: string[]; signedXpi: string | null }
  storeAssets: { listing: boolean; screenshots: number }
  credentials: { amo: boolean; cws: boolean; cwsItemId: string | null }
  next: { run: string; why: string }[]
}

function useExtensionStatus() {
  return useQuery<{ absent?: boolean; status?: ExtStatus } | null>({
    queryKey: ['setup', 'extension-status'],
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      try {
        const res = await fetch('/__setup/extension-status')
        if (!res.ok) return null
        const body = (await res.json()) as { ok: boolean; absent?: boolean; status?: ExtStatus }
        return body.ok ? body : null
      } catch {
        return null
      }
    },
  })
}

function CopyCmd({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(cmd)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      }}
      title="Copy"
      className="press flex w-full items-center justify-between gap-3 rounded-lg border border-line bg-white/[0.03] px-3 py-2 text-left font-mono text-[12px] text-ink-dim hover:border-line-bright"
    >
      <code className="truncate">{cmd}</code>
      <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint">{copied ? 'copied' : 'copy'}</span>
    </button>
  )
}

function StepRow({ done, children }: { done: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2.5 text-[13px] text-ink-dim">
      <span
        aria-hidden
        className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border ${done ? 'border-teal bg-teal/15 text-teal' : 'border-line text-transparent'}`}
      >
        <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M2.5 6.5l2.5 2.5 4.5-5" />
        </svg>
      </span>
      {children}
    </li>
  )
}

export function ExtensionPanel({ sectionTitle }: { sectionTitle: string }) {
  const { data, isLoading } = useExtensionStatus()

  return (
    <section className="mt-5 space-y-5 rounded-3xl border border-line card-surface p-6">
      <div className="space-y-1">
        <p className={sectionTitle}>Extension</p>
        <p className="flex items-center gap-2 text-sm text-ink-dim">
          Your site&rsquo;s browser extension, branded like the site, hosted by the site.
          <InfoDot>
            A read-only portfolio lens in the visitor&rsquo;s toolbar. The packaging step builds
            it with YOUR wordmark and copies the files into the site&rsquo;s own public folder,
            so every deploy distributes it at /extension. It never connects to a wallet and never
            signs anything.
          </InfoDot>
        </p>
      </div>

      {isLoading ? (
        <div className="h-24 animate-pulse rounded-xl bg-white/[0.04]" role="status" aria-label="Loading" />
      ) : !data ? (
        <p className="text-[13px] leading-relaxed text-ink-dim">
          This panel reads the local packaging state, so it works from the dev server only. Run{' '}
          <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[11px]">npm run dev</code>{' '}
          in <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[11px]">app/</code> and
          open /setup there, or drive it from the terminal: the walkthrough lives in{' '}
          <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[11px]">extension/README.md</code>.
        </p>
      ) : data.absent ? (
        <p className="text-[13px] leading-relaxed text-ink-dim">
          This checkout has no <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[11px]">extension/</code>{' '}
          package yet. It arrives with a kit update:{' '}
          <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[11px]">npm run update:site</code>
        </p>
      ) : data.status ? (
        <>
          <ul className="space-y-2">
            <StepRow done={data.status.built.chrome}>
              Chrome build {data.status.built.chrome && data.status.version ? `(v${data.status.version})` : ''}
            </StepRow>
            <StepRow done={data.status.built.firefox}>Firefox build</StepRow>
            <StepRow done={data.status.packaged.intoSite}>
              Packaged into the site
              <InfoDot>
                Copies the zips (and the signed .xpi when AMO keys exist) into app/public/extension/
                with an index.json descriptor. The /extension page renders from exactly that file,
                so this step is what makes the install page live.
              </InfoDot>
            </StepRow>
            <StepRow done={Boolean(data.status.packaged.signedXpi)}>
              Signed Firefox .xpi
              <InfoDot>
                One-click Firefox installs need a signed file. Unlisted AMO signing is an automated
                API step, not a review: add WEB_EXT_API_KEY and WEB_EXT_API_SECRET to
                extension/.env.local and re-run the packaging.
              </InfoDot>
            </StepRow>
            <StepRow done={data.status.storeAssets.listing}>
              Store submission pack ({data.status.storeAssets.screenshots} screenshot{data.status.storeAssets.screenshots === 1 ? '' : 's'})
            </StepRow>
            <StepRow done={data.status.credentials.cws}>
              Chrome Web Store credentials{data.status.credentials.cwsItemId ? ` (item ${data.status.credentials.cwsItemId})` : ''}
            </StepRow>
          </ul>

          {data.status.next.length > 0 && (
            <div className="space-y-2">
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">next, in order</p>
              {data.status.next.map((n) => (
                <div key={n.run} className="space-y-1">
                  <CopyCmd cmd={n.run.startsWith('add ') ? n.run : `cd extension && ${n.run}`} />
                  <p className="pl-1 font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint">{n.why}</p>
                </div>
              ))}
            </div>
          )}

          <details className="rounded-xl border border-line bg-white/[0.02] p-4">
            <summary className="cursor-pointer font-mono text-[11px] uppercase tracking-[0.14em] text-ink-dim">
              Publishing to the Chrome Web Store, one-time setup
            </summary>
            <ol className="mt-3 space-y-1.5 pl-1 text-[13px] leading-relaxed text-ink-dim">
              <li>1 · Register a developer account at chrome.google.com/webstore/devconsole ($5, once).</li>
              <li>2 · Open extension/store/listing.md and fill the listing text in the dashboard.</li>
              <li>
                3 · Pick <span className="text-ink">Unlisted</span> visibility, recommended for a
                white-label site: your visitors install from your link, and the store never lists
                you beside other operators.
              </li>
              <li>4 · Upload the Chrome zip from extension/artifacts/, submit for review.</li>
              <li>
                5 · Later updates are one command once CWS_CLIENT_ID, CWS_CLIENT_SECRET,
                CWS_REFRESH_TOKEN and CWS_ITEM_ID are in extension/.env.local:{' '}
                <code className="rounded bg-white/[0.06] px-1 py-0.5 font-mono text-[11px]">npm run publish:chrome</code>
              </li>
              <li>
                6 · Paste the live store URL into brand.config.ts as{' '}
                <code className="rounded bg-white/[0.06] px-1 py-0.5 font-mono text-[11px]">extensionStoreUrl</code>{' '}
                so /extension leads with the store button.
              </li>
            </ol>
          </details>
        </>
      ) : null}
    </section>
  )
}
