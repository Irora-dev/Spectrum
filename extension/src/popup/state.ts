// Popup state: a thin live view over chrome.storage. The popup renders the
// CACHED snapshot instantly (stamped with its age — cached data is presented
// as cached, always), asks the service worker to refresh, and re-renders from
// storage.onChanged. One writer (the worker); this surface only reads.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PortfolioSnapshot } from '../shared/portfolio'
import type { Rule } from '../shared/rules'
import {
  getBackoff,
  getRules,
  getSettings,
  getSnapshot,
  setRules as storeRules,
  setSettings as storeSettings,
  type Settings,
} from '../shared/storage'

export interface PopupState {
  ready: boolean
  settings: Settings | null
  snapshot: PortfolioSnapshot | null
  rules: Rule[]
  refreshing: boolean
  /** Consecutive failed polls (the worker's back-off counter) — 0 = healthy.
   *  Silent staleness is a lie of omission; the UI says checks are failing. */
  pollFailures: number
  refresh: () => void
  saveSettings: (patch: Partial<Settings>) => Promise<void>
  saveRules: (rules: Rule[]) => Promise<void>
}

export function usePopupState(): PopupState {
  const [ready, setReady] = useState(false)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [snapshot, setSnapshot] = useState<PortfolioSnapshot | null>(null)
  const [rules, setRulesState] = useState<Rule[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [pollFailures, setPollFailures] = useState(0)
  const autoRefreshed = useRef(false)

  useEffect(() => {
    let alive = true
    void Promise.all([getSettings(), getSnapshot(), getRules(), getBackoff()]).then(
      ([s, snap, r, b]) => {
        if (!alive) return
        setSettings(s)
        setSnapshot(snap)
        setRulesState(r)
        setPollFailures(b.failures)
        setReady(true)
      },
    )

    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area === 'local' && changes['snapshot/v1']) {
        setSnapshot((changes['snapshot/v1'].newValue as PortfolioSnapshot | undefined) ?? null)
        // A snapshot landing = the in-flight poll succeeded (whoever started it).
        setRefreshing(false)
      }
      if (area === 'local' && changes['backoff/v1']) {
        const next = (changes['backoff/v1'].newValue as { failures?: number } | undefined)?.failures ?? 0
        setPollFailures(next)
        // A failure landing also ends the in-flight poll.
        if (next > 0) setRefreshing(false)
      }
      if (area === 'sync' && changes['settings/v1']) {
        void getSettings().then(setSettings)
      }
      if (area === 'sync' && changes['rules/v1']) {
        void getRules().then(setRulesState)
      }
    }
    chrome.storage.onChanged.addListener(onChanged)
    return () => {
      alive = false
      chrome.storage.onChanged.removeListener(onChanged)
    }
  }, [])

  const refresh = useCallback(() => {
    // Any refresh satisfies the once-per-open auto-refresh — without this, the
    // first watch (save address → explicit refresh) also trips the staleness
    // effect and double-fires the poll.
    autoRefreshed.current = true
    setRefreshing(true)
    chrome.runtime.sendMessage({ type: 'poll-now' }, (resp?: { ok?: boolean; reason?: string }) => {
      void chrome.runtime.lastError
      // 'already-running': another poll (an alarm's) is mid-flight — keep the
      // spinner; the storage.onChanged handlers above end it on either outcome.
      if (resp?.reason === 'already-running') return
      setRefreshing(false)
    })
  }, [])

  // One auto-refresh per popup open, when the cache is older than the poll
  // cadence (or absent) — opening the popup is the user asking "now".
  useEffect(() => {
    if (!ready || autoRefreshed.current || !settings?.address) return
    const staleMs = settings.pollMinutes * 60_000
    const stale =
      !snapshot ||
      snapshot.address.toLowerCase() !== settings.address.toLowerCase() ||
      Date.now() - snapshot.at > staleMs
    if (stale) {
      autoRefreshed.current = true
      refresh()
    }
  }, [ready, settings, snapshot, refresh])

  const saveSettings = useCallback(async (patch: Partial<Settings>) => {
    const next = await storeSettings(patch)
    setSettings(next)
    chrome.runtime.sendMessage({ type: 'settings-changed' }, () => void chrome.runtime.lastError)
  }, [])

  const saveRules = useCallback(async (next: Rule[]) => {
    setRulesState(next)
    await storeRules(next)
  }, [])

  return { ready, settings, snapshot, rules, refreshing, pollFailures, refresh, saveSettings, saveRules }
}

/** Compact relative age for the freshness stamp: "now", "4m", "2h", "3d". */
export function ageLabel(atMs: number, now = Date.now()): string {
  const sec = Math.max(0, (now - atMs) / 1000)
  if (sec < 60) return 'now'
  const min = sec / 60
  if (min < 60) return `${Math.floor(min)}m`
  const h = min / 60
  if (h < 48) return `${Math.floor(h)}h`
  return `${Math.floor(h / 24)}d`
}
