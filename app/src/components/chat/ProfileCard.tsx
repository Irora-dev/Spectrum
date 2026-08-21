// In-chat creator profile (owner 2026-08-20: "updating creator profile").
// Mounts the REAL CreatorSignup — the same claim-a-name + profile flow the
// /creators page runs (typed-data handle claim, setNote profile write) — in
// chat chrome. Self-contained: the component owns its own wallet/query state.
import { CreatorSignup } from '../creator/CreatorSignup'

export function ProfileCard() {
  return (
    <div className="w-full min-w-0 overflow-hidden rounded-2xl border border-white/[0.1] bg-white/[0.03] p-2 sm:min-w-[var(--chat-card-min,24rem)] [--chat-card-min:0px]">
      <CreatorSignup />
    </div>
  )
}
