// Shared seed palette for the dither chart family. Mirrors the seeds in
// `dither-chart.tsx` so a series rendered through the composable engine reads
// with the exact same fill / line / star hues as the legacy sparkline.

export type Rgb = [number, number, number]

export type DitherColor =
  | "green"
  | "blue"
  | "purple"
  | "pink"
  | "orange"
  | "red"
  | "grey"

export type Seed = { fill: Rgb; line: Rgb; star: Rgb }

// Each seed: the area-fill hue, the bright series line, and the star sparkle.
export const PALETTE: Record<DitherColor, Seed> = {
  green: { fill: [40, 210, 110], line: [150, 255, 180], star: [200, 255, 220] },
  blue: { fill: [53, 143, 243], line: [150, 200, 255], star: [205, 228, 255] },
  purple: {
    fill: [150, 110, 255],
    line: [200, 175, 255],
    star: [225, 210, 255],
  },
  pink: { fill: [240, 90, 190], line: [255, 170, 220], star: [255, 205, 235] },
  orange: {
    fill: [255, 150, 50],
    line: [255, 195, 130],
    star: [255, 220, 175],
  },
  red: { fill: [240, 70, 70], line: [255, 150, 140], star: [255, 195, 185] },
  // No-data: a muted grey so empty metrics read as "nothing here".
  grey: { fill: [92, 92, 100], line: [140, 140, 150], star: [165, 165, 175] },
}

export const rgb = ([r, g, b]: Rgb, k = 1, a = 1) =>
  `rgba(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)},${a})`

/** A series colour: one of the named seeds, or ANY hex — Spectrum charts wear
 *  each basket's own identity colour (owner 2026-07-29), so the palette must
 *  accept arbitrary values, deriving line/star tints from the fill. */
export type SeriesColor = DitherColor | (string & {})

export const hexToRgb = (v: string): Rgb | null => {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim())
  if (!m) return null
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1]
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as unknown as Rgb
}
export const toward = (c: Rgb, t: number): Rgb =>
  c.map((x) => Math.round(x + (255 - x) * t)) as unknown as Rgb

export const seedOfColor = (color: SeriesColor): Seed => {
  const preset = PALETTE[color as DitherColor]
  if (preset) return preset
  const base = hexToRgb(color)
  if (!base) return PALETTE.grey
  return { fill: base, line: toward(base, 0.45), star: toward(base, 0.72) }
}

export const isDitherColor = (value: unknown): value is DitherColor =>
  typeof value === "string" && value in PALETTE

/** Weighted colour stops → a per-column Seed ramp (the constituent-gradient
 *  fill, owner 2026-07-29: a basket's chart wears ALL its assets' colours).
 *  Stops are laid out proportionally to weight; columns between stop centres
 *  interpolate linearly. */
export function seedRamp(stops: { color: string; weight: number }[], cols: number): Seed[] {
  const parsed = stops
    .map((st) => ({ rgb: hexToRgb(st.color), w: Math.max(0, st.weight) }))
    .filter((st): st is { rgb: Rgb; w: number } => st.rgb != null && st.w > 0)
  if (parsed.length === 0) return []
  const total = parsed.reduce((s2, st) => s2 + st.w, 0)
  // stop CENTRES at the middle of each weight band
  let acc = 0
  const centres = parsed.map((st) => {
    const c = (acc + st.w / 2) / total
    acc += st.w
    return { rgb: st.rgb, at: c }
  })
  const lerp = (a: Rgb, b: Rgb, t: number): Rgb =>
    [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)) as unknown as Rgb
  const out: Seed[] = []
  for (let x = 0; x < cols; x++) {
    const u = cols <= 1 ? 0 : x / (cols - 1)
    let rgbv: Rgb
    if (u <= centres[0].at) rgbv = centres[0].rgb
    else if (u >= centres[centres.length - 1].at) rgbv = centres[centres.length - 1].rgb
    else {
      let k = 0
      while (k < centres.length - 1 && centres[k + 1].at < u) k++
      const a = centres[k]
      const b = centres[k + 1]
      rgbv = lerp(a.rgb, b.rgb, (u - a.at) / (b.at - a.at || 1))
    }
    out.push({ fill: rgbv, line: toward(rgbv, 0.45), star: toward(rgbv, 0.72) })
  }
  return out
}
