// One poll: read the portfolio, store the snapshot, evaluate rules, notify.
// Dynamically imported by the entry AFTER the localStorage shim is installed
// and hydrated — this module's import graph reaches the shared lib.

import brand from '@app/brand.config'
import { badgeTextForDrift, setDriftBadge } from '../shared/badge'
import { flushLocalStorageShim } from '../shared/localstorage-shim'
import { computeDrift, readPortfolio } from '../shared/portfolio'
import { evaluateRules, type Firing } from '../shared/rules'
import {
  bumpBackoff,
  clearBackoff,
  filterCooldown,
  getBackoff,
  getRules,
  getSettings,
  getSnapshot,
  rememberNotificationLink,
  setSnapshot,
} from '../shared/storage'
import { portfolioUrl, siteBase, tokenUrl } from '../shared/deeplink'

export async function runPoll(trigger: 'alarm' | 'manual'): Promise<{ ok: boolean; reason?: string }> {
  const settings = await getSettings()
  if (!settings.address) {
    await setDriftBadge('')
    return { ok: false, reason: 'no-address' }
  }

  // Back off hard on failure — a manual refresh may still try (the user is
  // present and asking), but alarms respect the window.
  const backoff = await getBackoff()
  if (trigger === 'alarm' && Date.now() < backoff.untilMs) {
    return { ok: false, reason: 'backing-off' }
  }

  try {
    const prev = await getSnapshot()
    const snapshot = await readPortfolio(settings.address)
    await setSnapshot(snapshot)
    await clearBackoff()

    // The icon's drift figure — only off a COMPLETE read (a badge has no age
    // stamp or degraded strip, so partial data clears it instead).
    const complete = snapshot.chainsFailed.length === 0
    const drift = complete ? computeDrift(snapshot.assets, settings.targets) : null
    await setDriftBadge(badgeTextForDrift(drift?.aggregatePts))

    const rules = await getRules()
    if (rules.length > 0) {
      const firings = evaluateRules({
        rules,
        snapshot,
        prev: prev && prev.address === snapshot.address ? prev : null,
        targets: settings.targets,
      })
      const fresh = await filterCooldown(firings)
      for (const f of fresh) await notify(f, settings.siteUrl)
    }
    return { ok: true }
  } catch {
    await bumpBackoff(settings.pollMinutes)
    await setDriftBadge('') // never let a stale figure ride the icon
    return { ok: false, reason: 'read-failed' }
  } finally {
    // The worker may be killed right after this — persist the lib's TTL caches
    // (discovery checkpoints, pricing lookups) so the next poll starts warm.
    await flushLocalStorageShim()
  }
}

async function notify(f: Firing, settingsSiteUrl: string | undefined): Promise<void> {
  const id = `spectrum:${f.key}:${Date.now()}`
  const base = siteBase(settingsSiteUrl)
  if (base) {
    const url = f.intent === 'portfolio' ? portfolioUrl(base) : tokenUrl(base, f.intent.token.address, f.intent.token.chainId)
    await rememberNotificationLink(id, url)
  }
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title: f.title,
    message: f.body,
    // The honest footer: this is a cached read, not a live feed. Operator
    // wordmark, never ours (white-label — the owner 2026-08-02).
    contextMessage: `${brand.name} · read-only check`,
    priority: 0,
  })
}
