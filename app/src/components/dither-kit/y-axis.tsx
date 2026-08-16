"use client"

import { useChartPart } from "./chart-context"

export function YAxis({
  tickFormatter,
  tickCount = 4,
  tickMargin = 8,
}: {
  tickFormatter?: (value: number) => string
  tickCount?: number
  tickMargin?: number
}) {
  const ctx = useChartPart("YAxis")
  if (!ctx.ready) return null

  // EDGE-AWARE BASELINES (the owner 2026-08-06 12:18: the lowest price label sat
  // half over the date row — "the price should be moved up a bit to be
  // horizontally aligned with the bottom of the chart"). A label whose center
  // would cross the plot's bottom edge sits ON the edge instead (baseline
  // auto = text above the coordinate); the top edge mirrors it. Interior
  // ticks are byte-identical to before.
  const h = ctx.plot.height
  return (
    <g className="fill-current font-mono text-[10px] text-muted-foreground">
      {ctx.y.ticks(tickCount).map((t) => {
        const y = ctx.y(t)
        const baseline = y > h - 8 ? 'auto' : y < 8 ? 'hanging' : 'central'
        return (
          <text
            key={t}
            x={-tickMargin}
            y={y}
            textAnchor="end"
            dominantBaseline={baseline}
            fill="currentColor"
          >
            {tickFormatter ? tickFormatter(t) : t}
          </text>
        )
      })}
    </g>
  )
}
