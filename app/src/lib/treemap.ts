// Squarified treemap: partition a width × height box into weight-proportional
// rectangles that fully tile the space, largest first (top-left on a wide box).
// Returns rects in the same coordinate space as the input width/height.
// (Ported from the Prismbeat/spectrum-index implementation.)

export interface TmItem {
  ticker: string
  weight: number
}
export interface TmRect {
  ticker: string
  x: number
  y: number
  w: number
  h: number
}

export function squarify(items: TmItem[], width: number, height: number): TmRect[] {
  const total = items.reduce((s, it) => s + it.weight, 0)
  if (total <= 0 || width <= 0 || height <= 0 || items.length === 0) return []

  const nodes = [...items]
    .sort((a, b) => b.weight - a.weight)
    .map((it) => ({ ticker: it.ticker, area: (it.weight / total) * width * height }))

  const out: TmRect[] = []
  let x = 0
  let y = 0
  let w = width
  let h = height

  const worst = (row: { area: number }[], side: number): number => {
    let sum = 0
    let max = -Infinity
    let min = Infinity
    for (const r of row) {
      sum += r.area
      if (r.area > max) max = r.area
      if (r.area < min) min = r.area
    }
    const side2 = side * side
    const sum2 = sum * sum
    return Math.max((side2 * max) / sum2, sum2 / (side2 * min))
  }

  const layout = (row: { ticker: string; area: number }[]) => {
    const sum = row.reduce((s, r) => s + r.area, 0)
    if (w >= h) {
      const stripW = sum / h
      let cy = y
      for (const r of row) {
        const rh = r.area / stripW
        out.push({ ticker: r.ticker, x, y: cy, w: stripW, h: rh })
        cy += rh
      }
      x += stripW
      w -= stripW
    } else {
      const stripH = sum / w
      let cx = x
      for (const r of row) {
        const rw = r.area / stripH
        out.push({ ticker: r.ticker, x: cx, y, w: rw, h: stripH })
        cx += rw
      }
      y += stripH
      h -= stripH
    }
  }

  let row: { ticker: string; area: number }[] = []
  for (const node of nodes) {
    if (row.length === 0) {
      row.push(node)
      continue
    }
    const side = Math.min(w, h)
    if (worst(row, side) >= worst([...row, node], side)) {
      row.push(node)
    } else {
      layout(row)
      row = [node]
    }
  }
  if (row.length) layout(row)
  return out
}
