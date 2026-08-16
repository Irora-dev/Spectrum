// The toolbar badge: aggregate drift, on the icon, permanently glanceable —
// the product thesis (how far you sit from what you chose) without opening
// anything. Stamped from the same read as everything else, and BLANK whenever
// that read can't be trusted: a badge carries no freshness stamp, so on a
// degraded read, a failed poll, or no watched address it must clear rather
// than quietly go stale.

/** Badge copy for an aggregate drift figure. ≤4 chars (the platform truncates
 *  beyond that): '' under 1pt (noise), one decimal under 10, whole numbers to
 *  99, then '99+'. */
export function badgeTextForDrift(aggregatePts: number | null | undefined): string {
  if (aggregatePts == null || !isFinite(aggregatePts) || aggregatePts < 1) return ''
  if (aggregatePts >= 100) return '99+'
  if (aggregatePts >= 10) return String(Math.round(aggregatePts))
  return aggregatePts.toFixed(1)
}

/** Apply text to the action badge. Violet-deep ground + white text — drift is
 *  deviation, not danger; the alert red would editorialize. */
export async function setDriftBadge(text: string): Promise<void> {
  try {
    await chrome.action.setBadgeText({ text })
    if (text) {
      await chrome.action.setBadgeBackgroundColor({ color: '#4326a8' })
      // Chrome 110+ / Firefox — guarded: absent implementations just skip.
      await chrome.action.setBadgeTextColor?.({ color: '#ffffff' })
    }
  } catch {
    // A badge is decoration on the truth, never load-bearing.
  }
}
