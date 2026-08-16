/** THE GHOST BOOK — the found book as pure geometry: empty tiles breathing
 *  where YOURS will draw once connected. Deliberately data-free (no symbols,
 *  no numbers): a silhouette is a promise, a populated mock is a lie (the
 *  connection-honest rule). Shared by the ceremony's connect step and the
 *  homepage's get-started act. */
export function GhostBook({ heightClass = 'h-40' }: { heightClass?: string }) {
  return (
    <div aria-hidden className={`grid ${heightClass} grid-cols-[3fr_2fr_2fr] grid-rows-2 gap-2`}>
      {['row-span-2', '', '', 'col-span-2'].map((span, i) => (
        <div
          key={i}
          className={`animate-pulse rounded-xl border border-white/8 bg-white/[0.03] ${span}`}
          style={{ animationDelay: `${i * 260}ms`, animationDuration: '2.6s' }}
        />
      ))}
    </div>
  )
}
