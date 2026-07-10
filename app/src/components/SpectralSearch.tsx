// The glossy spectral search — a soft gradient halo behind, a gradient
// hairline ring around, glass + top sheen inside; the halo breathes brighter
// while focused. Born on Explore's thesis hero (owner ask 2026-07-06), now
// shared: Docs reuses it at the `md` size (owner 17:08 — "take the actual
// search bar from the explore page").
export function SpectralSearch({
  value,
  onChange,
  placeholder,
  onFocus,
  onBlur,
  size = 'lg',
  stretch = false,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  onFocus?: () => void
  onBlur?: () => void
  /** lg = the Explore hero (centered display face) · md = compact (Docs). */
  size?: 'lg' | 'md'
  /** Fill the parent's height (the Explore hero row stretches the search to
   *  the quick-swap card so their tops/bottoms align — owner 16:11). */
  stretch?: boolean
}) {
  const lg = size === 'lg'
  return (
    <div className={`group/search relative ${stretch ? 'h-full' : ''}`}>
      <div
        aria-hidden
        className={`pointer-events-none absolute ${lg ? '-inset-x-10 -inset-y-7' : '-inset-x-4 -inset-y-3'} opacity-35 blur-3xl transition-opacity duration-500 group-focus-within/search:opacity-70`}
        style={{ background: 'linear-gradient(90deg, rgba(53,224,255,0.55), rgba(164,139,255,0.6), rgba(255,77,184,0.55))' }}
      />
      <div
        className={`relative rounded-2xl p-[1.5px] transition-shadow duration-300 group-focus-within/search:shadow-[0_0_44px_-8px_rgba(164,139,255,0.75)] ${stretch ? 'h-full' : ''}`}
        style={{ background: 'linear-gradient(100deg, rgba(53,224,255,0.75), rgba(164,139,255,0.8) 50%, rgba(255,77,184,0.75))' }}
      >
        <label className={`relative block overflow-hidden rounded-[14.5px] bg-panel/92 shadow-[inset_0_1px_0_rgba(255,255,255,0.14)] backdrop-blur-xl ${stretch ? 'flex h-full items-center' : ''}`}>
          {/* glossy top sheen */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-1/2 rounded-t-[14.5px]"
            style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.07), transparent)' }}
          />
          <svg
            viewBox="0 0 24 24"
            className={`pointer-events-none absolute top-1/2 -translate-y-1/2 text-ink-faint ${lg ? 'left-4.5 h-5 w-5' : 'left-3.5 h-4 w-4'}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onFocus={onFocus}
            onBlur={onBlur}
            placeholder={placeholder}
            spellCheck={false}
            className={`relative w-full bg-transparent outline-none placeholder:text-ink-faint ${
              lg ? `${stretch ? 'py-0' : 'py-4.5'} pl-12 pr-4 text-center font-display text-lg text-ink` : 'py-2.5 pl-10 pr-3 text-sm text-ink'
            }`}
          />
        </label>
      </div>
    </div>
  )
}
