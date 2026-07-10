// Named gradient presets an operator can pick as their palette — harvested from
// spectrum-mini's theme catalog (the structural-styles lane). Each is a 3-stop
// {from, via, to}; brand.config.palette can use any of these (via the wizard's
// --gradient <id>) or supply custom stops. The gradient drives the spectral optics
// tokens (amber/magenta/cyan) across the site.

export interface GradientPreset {
  id: string
  label: string
  from: string
  via: string
  to: string
}

export const GRADIENT_CATALOG: GradientPreset[] = [
  { id: 'spectrum', label: 'Spectrum', from: '#ff9248', via: '#ff4db8', to: '#35e0ff' },
  { id: 'ocean', label: 'Ocean', from: '#3b82f6', via: '#06b6d4', to: '#22d3ee' },
  { id: 'ember', label: 'Ember', from: '#f59e0b', via: '#ef4444', to: '#ec4899' },
  { id: 'borealis', label: 'Borealis', from: '#22d3ee', via: '#34d399', to: '#a855f7' },
  { id: 'sunset', label: 'Sunset', from: '#f97316', via: '#f43f5e', to: '#a855f7' },
  { id: 'mint', label: 'Mint', from: '#34d399', via: '#10b981', to: '#06b6d4' },
  { id: 'grape', label: 'Grape', from: '#8b5cf6', via: '#a855f7', to: '#d946ef' },
  { id: 'gold', label: 'Gold', from: '#fbbf24', via: '#f59e0b', to: '#f97316' },
  { id: 'rose', label: 'Rose', from: '#fb7185', via: '#f43f5e', to: '#e11d48' },
  { id: 'ice', label: 'Ice', from: '#93c5fd', via: '#67e8f9', to: '#a5f3fc' },
  { id: 'magma', label: 'Magma', from: '#ef4444', via: '#f97316', to: '#fbbf24' },
  { id: 'monochrome', label: 'Monochrome', from: '#d1d5db', via: '#9ca3af', to: '#6b7280' },
  { id: 'ultraviolet', label: 'Ultraviolet', from: '#6366f1', via: '#8b5cf6', to: '#d946ef' },
  { id: 'citrus', label: 'Citrus', from: '#a3e635', via: '#facc15', to: '#fb923c' },
]

export function gradientById(id: string): GradientPreset | undefined {
  return GRADIENT_CATALOG.find((g) => g.id === id)
}
