import { useRef, useState } from 'react'
import { importAnyBundle } from '../../lib/spectrum/state-bundle'

/** THE RECOVERY DOOR (owner ~17:0x): the backup's import lived only inside
 *  the wallet pill's panel — exactly where a user with a wiped browser (empty
 *  book, no links, no draft) does not know to look. This quiet door mounts on
 *  the portfolio's empty states, where that user actually lands. One import
 *  reads both file kinds; every wallet link re-verifies on the way in. */
export function RestoreBackup() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [note, setNote] = useState<string | null>(null)

  async function onFile(file: File | undefined) {
    if (!file) return
    setNote(await importAnyBundle(await file.text()))
    if (fileRef.current) fileRef.current.value = ''
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-faint transition-colors hover:text-ink"
      >
        restore a backup
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="application/json"
        className="hidden"
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
      {note && <p className="mt-2 text-[11px] leading-relaxed text-ink-dim">{note}</p>}
    </div>
  )
}
