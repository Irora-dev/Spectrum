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

export function squarify(items: TmItem[], width: number, height: number, keepOrder = false): TmRect[] {
  const total = items.reduce((s, it) => s + it.weight, 0)
  if (total <= 0 || width <= 0 || height <= 0 || items.length === 0) return []

  // keepOrder: lay out in the GIVEN order instead of weight-desc — a live
  // drag freezes slot order so tiles resize in place rather than swapping
  // slots on every rank crossing (aspect ratios suffer transiently; the
  // settle re-sorts).
  const nodes = (keepOrder ? [...items] : [...items].sort((a, b) => b.weight - a.weight)).map((it) => ({
    ticker: it.ticker,
    area: (it.weight / total) * width * height,
  }))

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

/** STRIP-FROZEN re-apportion (live dialing): keep the rest layout's strip
 *  structure and re-divide space ONLY inside each strip, along its run axis,
 *  by the given weights. A strip whose members' weights are unchanged emits
 *  its rects byte-identical — so dialing one asset moves nothing but its own
 *  strip-mates, and a tile alone in its strip visibly holds (its numbers
 *  stay live; the release layout completes the move). Strips are recovered
 *  from the rects themselves: members of a vertical run share x and w;
 *  members of a horizontal run share y and h — AND sit contiguous along the
 *  run axis. Alignment alone is not adjacency: two full-height columns
 *  flanking a middle pair share y+h yet re-flowing them as one run teleports
 *  the far column onto whatever sits between (the dial's col·pair·col rest
 *  layout — measured overlap, 2026-08-03). */
export function reapportionStrips(rest: TmRect[], weight: Map<string, number>): TmRect[] {
  const eps = 0.5
  const used = new Set<number>()
  const out: TmRect[] = []
  // The maximal aligned run through i that is also CONTIGUOUS: sort the
  // aligned candidates along the run axis, then extend from i while each
  // neighbour starts where the previous tile ends.
  const contiguousRun = (i: number, cand: number[], main: 'x' | 'y', size: 'w' | 'h'): number[] => {
    const ordered = [...cand].sort((a, b) => rest[a][main] - rest[b][main])
    const at = ordered.indexOf(i)
    let lo = at
    let hi = at
    while (lo > 0 && Math.abs(rest[ordered[lo - 1]][main] + rest[ordered[lo - 1]][size] - rest[ordered[lo]][main]) < eps) lo--
    while (hi < ordered.length - 1 && Math.abs(rest[ordered[hi]][main] + rest[ordered[hi]][size] - rest[ordered[hi + 1]][main]) < eps) hi++
    return ordered.slice(lo, hi + 1)
  }
  for (let i = 0; i < rest.length; i++) {
    if (used.has(i)) continue
    const vert: number[] = [i]
    const horz: number[] = [i]
    for (let j = 0; j < rest.length; j++) {
      if (j === i || used.has(j)) continue
      if (Math.abs(rest[j].x - rest[i].x) < eps && Math.abs(rest[j].w - rest[i].w) < eps) vert.push(j)
      else if (Math.abs(rest[j].y - rest[i].y) < eps && Math.abs(rest[j].h - rest[i].h) < eps) horz.push(j)
    }
    const vRun = contiguousRun(i, vert, 'y', 'h')
    const hRun = contiguousRun(i, horz, 'x', 'w')
    const grp = (vRun.length >= hRun.length ? vRun : hRun).sort((a, b) => a - b)
    grp.forEach((n) => used.add(n))
    const strip = grp.map((n) => rest[n])
    if (strip.length === 1) {
      out.push({ ...strip[0] })
      continue
    }
    const isVert = Math.abs(strip[0].x - strip[1].x) < eps && Math.abs(strip[0].w - strip[1].w) < eps
    const total = strip.reduce((s, r) => s + Math.max(1e-9, weight.get(r.ticker) ?? 1), 0)
    if (isVert) {
      const ordered = [...strip].sort((a, b) => a.y - b.y)
      const y0 = ordered[0].y
      const H = ordered.reduce((s, r) => s + r.h, 0)
      let cy = y0
      for (const r of ordered) {
        const h = (H * Math.max(1e-9, weight.get(r.ticker) ?? 1)) / total
        out.push({ ...r, y: cy, h })
        cy += h
      }
    } else {
      const ordered = [...strip].sort((a, b) => a.x - b.x)
      const x0 = ordered[0].x
      const W = ordered.reduce((s, r) => s + r.w, 0)
      let cx = x0
      for (const r of ordered) {
        const w = (W * Math.max(1e-9, weight.get(r.ticker) ?? 1)) / total
        out.push({ ...r, x: cx, w })
        cx += w
      }
    }
  }
  return out
}

/** Grouped treemap (the spotlight's "rearranged to be grouped together" + the
 *  group-by pills on the picture): the box splits along its long side by each
 *  group's share of the total, and each group squarifies inside its own
 *  region — a group's tiles are CONTIGUOUS by construction, not by hoping a
 *  sort lands them adjacent (plain squarify re-sorts by weight, so input
 *  order cannot group anything). `gap` opens a small seam between regions so
 *  the clustering reads as deliberate. One non-empty group degrades to plain
 *  squarify — switching a grouping off glides every tile straight home. */
export function squarifyGroups(groups: TmItem[][], width: number, height: number, gap = 0, keepOrder = false): TmRect[] {
  const live = groups.filter((g) => g.length > 0)
  if (live.length === 0) return []
  if (live.length === 1) return squarify(live[0], width, height, keepOrder)
  const total = live.flat().reduce((s, it) => s + it.weight, 0)
  if (total <= 0 || width <= 0 || height <= 0) return []
  const seams = gap * (live.length - 1)
  const out: TmRect[] = []
  let x = 0
  let y = 0
  for (const g of live) {
    const share = g.reduce((s, it) => s + it.weight, 0) / total
    if (width >= height) {
      const gw = Math.max(0, width - seams) * share
      out.push(...squarify(g, gw, height, keepOrder).map((r) => ({ ...r, x: r.x + x })))
      x += gw + gap
    } else {
      const gh = Math.max(0, height - seams) * share
      out.push(...squarify(g, width, gh, keepOrder).map((r) => ({ ...r, y: r.y + y })))
      y += gh + gap
    }
  }
  return out
}
