// The whole UI: one scrolling column in a 380×600 window. No tabs, no nav —
// a popup with navigation is a website in a costume. Cached state renders
// instantly with its age on it; the single write-path is the Modify hand-off
// to the site.

import { useMemo, useState } from 'react'
import { SUPPORTED_CHAIN_IDS } from '@app/lib/chain/chains'
import { computeDrift } from '../shared/portfolio'
import { clearSnapshot } from '../shared/storage'
import { portfolioUrl, siteBase } from '../shared/deeplink'
import { usePopupState } from './state'
import { AlertsPanel } from './components/AlertsPanel'
import { MicroLabel, SpinnerArc } from './components/bits'
import { CreatedStrip } from './components/CreatedStrip'
import { EmptyState } from './components/EmptyState'
import { ExposureList } from './components/ExposureList'
import { DegradedNote, FailingNote, Header } from './components/Header'
import { Overview } from './components/Overview'
import { SettingsPanel } from './components/SettingsPanel'
import { chainLabel } from './components/bits'

export function App() {
  const state = usePopupState()
  const [settingsOpen, setSettingsOpen] = useState(false)

  const { settings, rules } = state
  // A snapshot for a previously-watched address is not this address's data.
  const snapshot =
    state.snapshot && settings?.address && state.snapshot.address.toLowerCase() === settings.address.toLowerCase()
      ? state.snapshot
      : null

  // Drift is only computed off a COMPLETE read: with a chain missing, every
  // weight is a share of a smaller total, so every delta would lie — the
  // degraded strip explains the pause instead.
  const degraded = (snapshot?.chainsFailed.length ?? 0) > 0
  const drift = useMemo(
    () => computeDrift(degraded ? [] : (snapshot?.assets ?? []), degraded ? {} : (settings?.targets ?? {})),
    [snapshot, settings, degraded],
  )

  if (!state.ready || !settings) {
    return <div className="h-full w-full" />
  }

  const base = siteBase(settings.siteUrl)
  const watching = !!settings.address

  return (
    <div className="relative flex h-full flex-col">
      <Header
        snapshotAt={snapshot?.at ?? null}
        refreshing={state.refreshing}
        onRefresh={state.refresh}
        onSettings={() => setSettingsOpen(true)}
        watching={watching}
      />

      {!watching ? (
        <EmptyState
          onWatch={(address) => {
            void state.saveSettings({ address }).then(state.refresh)
          }}
        />
      ) : !snapshot ? (
        !state.refreshing && state.pollFailures > 0 ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 pb-14">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-alert" />
            <p className="text-center font-mono text-[11px] leading-relaxed text-ink-dim">
              The read didn&rsquo;t complete. Every chain failed or the network is unreachable, and
              nothing is shown rather than something wrong.
            </p>
            <button
              type="button"
              onClick={state.refresh}
              className="press rounded-full border border-line bg-white/[0.03] px-4 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim hover:border-line-bright hover:text-ink"
            >
              try again
            </button>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 pb-14">
            <SpinnerArc size={20} />
            <p className="text-center font-mono text-[11px] leading-relaxed text-ink-dim">
              Reading chain. The first look discovers baskets on {SUPPORTED_CHAIN_IDS.length} chains
              and can take a moment.
            </p>
          </div>
        )
      ) : (
        <>
          <FailingNote failures={state.pollFailures} snapshotAt={snapshot.at} />
          <DegradedNote chainsFailed={snapshot.chainsFailed} labels={chainLabel} />

          <main className="popup-scroll min-h-0 flex-1 pb-6">
            <Overview snapshot={snapshot} drift={drift} />

            {snapshot.heldCount === 0 ? (
              <div className="px-4 pt-6">
                <MicroLabel>exposure</MicroLabel>
                <p className="mt-3 font-mono text-[11px] leading-relaxed text-ink-dim">
                  No basket balance found for this address
                  {snapshot.chainsFailed.length > 0 ? ' on the chains that answered' : ''}. When it holds
                  baskets, they decompose here into net per-asset exposure.
                </p>
              </div>
            ) : (
              <ExposureList
                assets={snapshot.assets}
                drift={drift}
                degraded={degraded}
                targets={settings.targets}
                base={base}
                onSaveTargets={(targets) => state.saveSettings({ targets })}
              />
            )}

            <CreatedStrip created={snapshot.created} base={base} />

            <AlertsPanel
              rules={rules}
              onChange={(r) => void state.saveRules(r)}
              pollMinutes={settings.pollMinutes}
              hasTargets={Object.keys(settings.targets).length > 0}
            />
          </main>

          <footer className="shrink-0 border-t border-line p-4">
            {base ? (
              /* The one write-path action — the loudest thing on the surface,
                 same solid accent as Watch and Save (primary = solid cyan). */
              <a
                href={portfolioUrl(base)}
                target="_blank"
                rel="noreferrer"
                className="press flex h-10 items-center justify-center gap-2 rounded-xl bg-cyan font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-void"
              >
                modify
                <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden>
                  <path d="M2 6h8M7 3l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </a>
            ) : (
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                className="press card-surface flex h-10 w-full items-center justify-center rounded-xl font-mono text-[11px] uppercase tracking-[0.16em] text-ink-dim hover:text-ink"
              >
                set your site to act →
              </button>
            )}
          </footer>
        </>
      )}

      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          onSave={state.saveSettings}
          onClose={() => setSettingsOpen(false)}
          onStopWatching={async () => {
            await state.saveSettings({ address: undefined, targets: {} })
            await clearSnapshot()
          }}
        />
      )}
    </div>
  )
}
