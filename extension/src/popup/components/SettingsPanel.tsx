// Settings: the watched address (read-only — an address, never a connection),
// the operator site actions hand off to, and the poll cadence. One overlay
// panel, one level deep — a popup with navigation is a website in a costume.

import { useState } from 'react'
import { isAddress } from 'viem'
import brand from '@app/brand.config'
import { POLL_MINUTES_FLOOR, type Settings } from '../../shared/storage'
import { MicroLabel } from './bits'

const INTERVALS = [5, 15, 30, 60]

export function SettingsPanel({
  settings,
  onSave,
  onClose,
  onStopWatching,
}: {
  settings: Settings
  onSave: (patch: Partial<Settings>) => Promise<void>
  onClose: () => void
  onStopWatching: () => Promise<void>
}) {
  const [address, setAddress] = useState(settings.address ?? '')
  const [siteUrl, setSiteUrl] = useState(settings.siteUrl ?? '')
  const [pollMinutes, setPollMinutes] = useState(settings.pollMinutes)
  const [confirmStop, setConfirmStop] = useState(false)

  const addrTrim = address.trim()
  const addrValid = addrTrim === '' || isAddress(addrTrim, { strict: false })

  const save = async () => {
    await onSave({
      address: addrTrim === '' ? undefined : addrTrim,
      siteUrl: siteUrl.trim() === '' ? undefined : siteUrl.trim(),
      pollMinutes,
    })
    onClose()
  }

  return (
    <div
      className="absolute inset-0 z-10 flex flex-col bg-void/80 backdrop-blur-sm"
      role="dialog"
      aria-label="Settings"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <div className="card-surface m-4 flex min-h-0 flex-1 flex-col rounded-2xl">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-white/10 px-4">
          <span className="font-display text-[13px] font-semibold tracking-[0.06em] text-ink">SETTINGS</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="press grid h-7 w-7 place-items-center rounded-full text-ink-dim hover:text-ink"
          >
            <svg viewBox="0 0 10 10" className="h-3 w-3" aria-hidden>
              <path d="M1.5 1.5l7 7m0-7l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="popup-scroll min-h-0 flex-1 px-4 py-5">
          <label className="block">
            <MicroLabel>watched address</MicroLabel>
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              spellCheck={false}
              autoFocus
              placeholder="0x…"
              className={`mt-2 w-full rounded-lg border bg-white/[0.04] px-3 py-2 font-mono text-[12px] text-ink outline-none placeholder:text-ink-faint ${
                addrValid ? 'border-line focus:border-line-bright' : 'border-alert/60'
              }`}
            />
            <p className="mt-2 font-mono text-[10px] leading-relaxed text-ink-faint">
              Read-only. The lens watches an address. It never connects, never signs, never asks for a
              seed phrase.
            </p>
            {!addrValid && <p className="mt-1 font-mono text-[10px] text-alert">Not a valid EVM address.</p>}
          </label>

          <label className="mt-6 block">
            <MicroLabel>your {brand.name} site</MicroLabel>
            <input
              value={siteUrl}
              onChange={(e) => setSiteUrl(e.target.value)}
              spellCheck={false}
              placeholder="https://…"
              className="mt-2 w-full rounded-lg border border-line bg-white/[0.04] px-3 py-2 font-mono text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-line-bright"
            />
            <p className="mt-2 font-mono text-[10px] leading-relaxed text-ink-faint">
              Where Modify hands off. The extension only watches; acting happens on the site, with fresh
              numbers, never landing on a signature.
            </p>
          </label>

          <div className="mt-6">
            <MicroLabel>check every</MicroLabel>
            <div className="mt-2 inline-flex items-center gap-0.5 rounded-full border border-white/10 bg-white/[0.03] p-0.5">
              {INTERVALS.map((m) => {
                const active = pollMinutes === m
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setPollMinutes(m)}
                    aria-pressed={active}
                    className={`press relative rounded-full px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] ${
                      active ? 'text-void' : 'text-ink-faint hover:text-ink'
                    }`}
                  >
                    {active && <span aria-hidden className="absolute inset-0 rounded-full bg-cyan" />}
                    <span className="relative tnum">{m}m</span>
                  </button>
                )
              })}
            </div>
            <p className="mt-2 font-mono text-[10px] leading-relaxed text-ink-faint">
              While your browser is open. A closed or sleeping machine isn&rsquo;t checked, so alerts are
              never &ldquo;instant&rdquo;. Floor {POLL_MINUTES_FLOOR} min: a portfolio moves in hours, and
              polling faster just burns RPC quota.
            </p>
          </div>

          {settings.address && (
            <div className="mt-6 border-t border-white/10 pt-5">
              {confirmStop ? (
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono text-[11px] text-ink-dim">Forget address, snapshot and targets?</span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setConfirmStop(false)}
                      className="press rounded-full px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint hover:text-ink"
                    >
                      keep
                    </button>
                    <button
                      type="button"
                      onClick={() => void onStopWatching().then(onClose)}
                      className="press rounded-full bg-alert px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-void"
                    >
                      forget
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmStop(true)}
                  className="press font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint hover:text-alert"
                >
                  stop watching this address
                </button>
              )}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-white/10 p-4">
          <button
            type="button"
            onClick={() => void save()}
            disabled={!addrValid}
            className={`press h-10 w-full rounded-xl font-mono text-[11px] font-medium uppercase tracking-[0.16em] ${
              addrValid ? 'bg-cyan text-void' : 'bg-white/10 text-ink-faint'
            }`}
          >
            save
          </button>
        </div>
      </div>
    </div>
  )
}
