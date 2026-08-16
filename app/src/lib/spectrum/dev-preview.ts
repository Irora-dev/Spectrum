// ─────────────────────────────────────────────────────────────────────────────
// The DEV PREVIEW address — the one address the dev stand-ins are allowed to
// answer for. Pages fall back to it in dev when no wallet is connected, so the
// surfaces render populated; the moment a REAL wallet connects, every read is
// real (owner 2026-08-03 ~11:5x: connecting still showed "the default nvidia,
// syrup, aave" — the fixture had been answering for real accounts too).
//
// Deliberately its own tiny module: dev-fixture.ts is only ever dynamic-
// imported behind `import.meta.env.DEV`, so exporting this from there would
// pull the whole demo catalogue into a production bundle. This constant is
// bundle-safe anywhere.
// ─────────────────────────────────────────────────────────────────────────────

export const DEV_PREVIEW_ADDRESS = '0x000000000000000000000000000000000000d0e0'

/** Is this read for the dev preview identity (the only account stand-ins may
 *  answer for)? Accepts a single address or a group read. */
export function isDevPreview(address: string | string[] | undefined): boolean {
  const list = Array.isArray(address) ? address : address ? [address] : []
  return list.some((a) => a.toLowerCase() === DEV_PREVIEW_ADDRESS)
}
