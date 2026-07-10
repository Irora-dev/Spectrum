// Design-style presets. `Record<DesignStyle, …>` forces one per style. Surfaces / ink /
// accent / fonts come from the preset; the operator's palette overrides the gradient
// (amber/magenta/cyan) + optional accent in operatorBrandToTheme.
//
// `spectral` MUST reproduce the reference look byte-for-byte (its values are the current
// `@theme` tokens in index.css) — so a default kit build looks exactly like today.
// aurora / prism are first-pass alternates (tunable) that prove the seam re-skins.

import type { DesignStyle, OperatorTheme } from './brand'
import { SPECTRUM_DNA } from './brand'

const FONTS = {
  fontDisplay: '"Chakra Petch", ui-sans-serif, system-ui, sans-serif',
  fontMono: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontNum: '"Space Grotesk", ui-sans-serif, system-ui, sans-serif',
} as const

// Gradient defaults (overridden by the operator's palette); kept identical across presets
// so the operator's chosen gradient is what differs, not the style.
const GRADIENT = {
  amber: SPECTRUM_DNA.gradientFrom,
  magenta: SPECTRUM_DNA.gradientVia,
  cyan: SPECTRUM_DNA.gradientTo,
} as const

export const STYLE_PRESETS: Record<DesignStyle, OperatorTheme> = {
  // Exact current index.css @theme values — do not drift.
  spectral: {
    ...FONTS,
    void: '#07070b',
    panel: '#0c0c12',
    panel2: '#111119',
    line: '#1c1c28',
    lineBright: '#2c2c3c',
    ink: '#e8e8f0',
    inkDim: '#8b8b9e',
    inkFaint: '#565669',
    violet: '#7b5cff',
    violetBright: '#a48bff',
    violetDeep: '#4326a8',
    alert: '#ff3b52',
    teal: '#34d6c4',
    ...GRADIENT,
  },
  // Cool near-black, brighter ink — a crisper, cooler take on the spectral DNA.
  prism: {
    ...FONTS,
    void: '#050507',
    panel: '#0b0b12',
    panel2: '#10101a',
    line: '#1c1c28',
    lineBright: '#2c2c3c',
    ink: '#f4f4fa',
    inkDim: '#9494a8',
    inkFaint: '#55556a',
    violet: '#6b7bff',
    violetBright: '#9bb0ff',
    violetDeep: '#2a2a8a',
    alert: '#ff3b52',
    teal: '#35e0d0',
    ...GRADIENT,
  },
  // Indigo-tinted voids, warm off-white ink, violet accent — a softer, aurora feel.
  aurora: {
    ...FONTS,
    void: '#080611',
    panel: '#0e0b1c',
    panel2: '#141026',
    line: '#221a3a',
    lineBright: '#332a52',
    ink: '#ece9f6',
    inkDim: '#a99fc4',
    inkFaint: '#6a5f86',
    violet: '#b46bff',
    violetBright: '#cf9bff',
    violetDeep: '#4326a8',
    alert: '#ff5b9c',
    teal: '#5ff0c0',
    ...GRADIENT,
  },
  // umbra + sylvan: harvested from spectrum-mini's structural-styles lane, mapped first-pass
  // onto the 19 operator tokens (colour only — the structural half: radii/surface/depth, and
  // the light `halation` style, are a follow-up; visual-tune pending).
  // umbra — opaque near-black "crypto fintech": solid cards, white ink, violet accent (dark).
  umbra: {
    ...FONTS,
    void: '#151517',
    panel: '#222225',
    panel2: '#2b2b2f',
    line: '#33333a',
    lineBright: '#45454d',
    ink: '#ffffff',
    inkDim: '#8e8e93',
    inkFaint: '#636366',
    violet: '#a845ff',
    violetBright: '#c77dff',
    violetDeep: '#5a1a8a',
    alert: '#ff453a',
    teal: '#32d74b',
    ...GRADIENT,
  },
  // sylvan — organic institutional: deep green-black voids, parchment ink, lime "yield" accent;
  // carries its OWN green→lime gradient default (the operator's palette still overrides it).
  sylvan: {
    ...FONTS,
    void: '#0d1210',
    panel: '#161d1a',
    panel2: '#1e2621',
    line: '#26302b',
    lineBright: '#33403a',
    ink: '#f4f3ee',
    inkDim: '#8a9690',
    inkFaint: '#5c6761',
    violet: '#c7ff51',
    violetBright: '#e2ff9c',
    violetDeep: '#5fd08a',
    alert: '#ff3b62',
    teal: '#5fd08a',
    amber: '#163a24',
    magenta: '#5fd08a',
    cyan: '#c7ff51',
  },
}
