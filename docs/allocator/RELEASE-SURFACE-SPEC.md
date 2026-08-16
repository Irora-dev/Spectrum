# The release surface — spec for confirm (NOT built)

> status: derived · as-of: 2026-08-07 · author: specallocator · **awaiting the owner's confirm**
> Plan-first per his standing rule: the exact plan is written before any build, and "how we show
> it / how it works" needs his explicit word. **Nothing in this document is implemented.**

## Why this exists at all

Three separate mechanisms now hold a record that **only a human can release**, and today none of
them has any exit except "clear site data" — which destroys *other* live records, including ones
that may have money in flight. Building three panels would be three chances to get it wrong, so
this is one surface for all three:

| What holds a record | Why it is held | Source |
|---|---|---|
| `dup:` records | Two runs claimed the same step; the second is permanently held so it can never re-buy | `submission-store` |
| Ambiguous claims | The wallet was asked and never answered clearly — money **may** be in flight, and **ambiguity does not expire** (a TTL measures liveness; ambiguity has none) | `claimStep` → `held-ambiguous` |
| Quarantined rows | A stored row we could not parse. Kept as evidence, refusing everything, rather than erased | `quarantineUnknownRows` / `quarantinedRaw` |

**The forbidden shortcut, stated up front:** nothing in the runner may clear these automatically.
Auto-clearing what law 12 refuses on is the forbidden fallback wearing a broom — the whole point
is that a person looks.

## What it is

**One panel, reachable from the executor, listing every held entry.** Read-only by default; each
row carries its own release control. Not a settings page and not a modal over the flow — a place
you can arrive at, read slowly, and leave without having changed anything.

## The three states, in the user's words

Each row says **what happened**, **what it means for their money**, and **what releasing does** —
in that order, because the third is only safe to read after the second.

- **Held — the same step twice.** "Another tab or an earlier attempt already sent this step. We are
  keeping this copy locked so it can never be sent again." Releasing: "Only release this if you have
  checked your wallet activity and this step is **not** there."
- **Unanswered — your wallet never confirmed.** "We asked your wallet to send this and never got a
  clear answer. It may have gone through. We will not send it again until you tell us." Releasing:
  "Check your wallet activity first. If the transaction is there, mark it sent. If it is not there,
  releasing lets the run try again." **This is the dangerous one and its copy must be the slowest.**
- **Unreadable — we could not read this record.** "Something wrote a record here we cannot
  understand, so we are refusing to act on this step at all. Your money is not affected by this
  record; it just blocks this step." Releasing: "This discards the unreadable record. Any step it
  was blocking becomes available again."

## Screens (ASCII, deliberately)

```
┌─ HELD RECORDS ──────────────────────────────────── 3 ─┐
│  Nothing here is sent automatically. A person decides. │
│                                                        │
│  ⚠ UNANSWERED · Base · buy 4 assets · 2h ago          │
│    We asked your wallet to send this and never got a    │
│    clear answer. It may have gone through.              │
│    → Check your wallet activity, then:                  │
│      [ It went through ]   [ It did not — let it retry ]│
│                                                        │
│  ⏸ HELD · Ethereum · buy 2 assets · 5h ago            │
│    An earlier attempt already sent this step.           │
│      [ Release (I checked — it is not there) ]           │
│                                                        │
│  ✖ UNREADABLE · 1 record                               │
│    We cannot read this record, so this step is blocked. │
│      [ Discard the unreadable record ]                  │
└────────────────────────────────────────────────────────┘
```

Empty state: **"Nothing is held. This page is empty when everything is normal."** — so an empty
page reads as health rather than as a broken screen.

## The rules the build must follow

1. **A release requires an explicit acknowledgment**, never a bare click. The unanswered case
   offers two *named outcomes* ("it went through" / "it did not") rather than one Release button,
   because those are different facts with different consequences and the user is the only one who
   can tell them apart.
2. **No bulk release.** No "clear all". Each entry is its own decision; a sweep is how someone
   releases the one that mattered by accident.
3. **The panel never writes on load.** Reading must not mutate — the current bug class is records
   being cleared by something other than a person.
4. **Words, not codes.** No `dup:`, no `held-ambiguous`, no chain ids. Symbols go through
   `safe-copy`; a deployer-controlled symbol reaches this surface.
5. **It states what it cannot know.** The panel cannot check the chain. Every instruction that
   depends on the chain says "check your wallet activity" and never implies we have.
6. **Reachable when the runner is not.** Its whole job is the aftermath of a run that ended badly,
   so it must not live inside the run's own flow.

## Open questions for the owner (the reason this is a confirm, not a build)

1. **Where does it live?** A route (`/portfolio/held`), a section of the executor, or a settings
   entry? My recommendation: its own route, linked from the runner's refusal sentences — those are
   exactly the moments a person needs it.
2. **Does "it went through" need a transaction hash?** Asking for one makes the acknowledgment
   evidence-backed rather than a guess. It also blocks a user who cannot find it. My
   recommendation: optional field, and the record notes whether one was given.
3. **Should the unanswered case offer "let it retry" at all**, or only "it went through" plus
   "leave it held"? Offering retry is what makes the panel useful; it is also the one control that
   can cause a double buy if someone answers wrongly.

## What I would build once confirmed

Read-only wiring first (list + copy, no controls) so the states can be seen against real records,
then the per-entry acknowledgments. `quarantineUnknownRows` and `quarantinedRaw` are already built
and pinned for this; `liveSubmissions` exists and currently has no non-test caller — this panel is
its intended one.

**Gate note:** this surface is precondition 4 of the go-live interlock (A10). Until it exists, a
live flip fails the build with the sentence "the human release surface does not exist".
