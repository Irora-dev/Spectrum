import type { Eip1193Like } from './batch-calls'

// ─────────────────────────────────────────────────────────────────────────────
// THE ADVERSARIAL WALLET (exotic path 1, the owner's "do all of these" 2026-08-04)
// — a scriptable EIP-1193 provider that misbehaves in DOCUMENTED ways, because
// the wallet is the one component we do not control and every runner law is a
// claim about wallet behaviour that nothing had contradicted until this file.
//
// TEST FIXTURE: imported only by test suites; no app code may import it (it
// ships nothing and vite tree-shakes it out of the bundle).
//
// The misbehaviors are SCRIPTS, not modes — each test composes the exact lie
// it is probing:
//   · return a call id, then answer "unknown id" forever   (the forgetful wallet)
//   · report a confirmed wrapper over a reverted receipt   (the flattering wallet)
//   · return the same id for two different requests        (the echoing wallet)
//   · answer with shapes no spec ever defined              (the garbled wallet)
//   · stay pending past any budget                         (the stalling wallet)
//   · throw mid-poll                                       (the flaky transport)
// Account switches and wrong-hash receipts are driven at the effects/client
// seams (activeAccount / getTransactionReceipt) by the same suites.
// ─────────────────────────────────────────────────────────────────────────────

export interface AdversarialWalletScript {
  /** wallet_getCapabilities: report atomic batching on every chain (default
   *  true). An Error value makes the probe itself throw. */
  atomic?: boolean | Error
  /** Consumed one per wallet_sendCalls request; an Error throws it (a wallet
   *  refusing/rejecting pre-submission). The LAST entry repeats. */
  sendCalls?: (string | Error)[]
  /** Per calls-id: the wallet_getCallsStatus answer sequence; an Error throws
   *  it (transport blip / "unknown id"). The LAST entry repeats. */
  callsStatus?: Record<string, unknown[]>
}

export interface AdversarialWallet extends Eip1193Like {
  /** Every request made, in order — lets a test assert the wallet was NEVER
   *  touched on a refusal path (the strongest claim a refusal can make). */
  requests: { method: string; params?: unknown[] }[]
}

export function adversarialWallet(script: AdversarialWalletScript = {}): AdversarialWallet {
  const requests: AdversarialWallet['requests'] = []
  let sendCallsIndex = 0
  const statusIndex = new Map<string, number>()

  return {
    requests,
    async request(args: { method: string; params?: unknown[] }): Promise<unknown> {
      requests.push(args)
      switch (args.method) {
        case 'wallet_getCapabilities': {
          if (script.atomic instanceof Error) throw script.atomic
          const supported = script.atomic !== false
          // one entry per plausible chain — the parser looks its chain up by hex key
          const entry = { atomic: { status: supported ? 'supported' : 'unsupported' } }
          return Object.fromEntries([1, 8453, 4663].map((id) => [`0x${id.toString(16)}`, entry]))
        }
        case 'wallet_sendCalls': {
          const seq = script.sendCalls ?? []
          if (seq.length === 0) throw Object.assign(new Error('wallet_sendCalls not scripted'), { code: -32601 })
          const v = seq[Math.min(sendCallsIndex, seq.length - 1)]
          sendCallsIndex += 1
          if (v instanceof Error) throw v
          return { id: v }
        }
        case 'wallet_getCallsStatus': {
          const id = String((args.params as unknown[] | undefined)?.[0] ?? '')
          const seq = script.callsStatus?.[id]
          if (!seq || seq.length === 0) throw new Error(`unknown bundle id ${id}`)
          const i = statusIndex.get(id) ?? 0
          statusIndex.set(id, Math.min(i + 1, seq.length - 1))
          const v = seq[Math.min(i, seq.length - 1)]
          if (v instanceof Error) throw v
          return v
        }
        default:
          throw Object.assign(new Error(`method ${args.method} not scripted`), { code: -32601 })
      }
    },
  }
}
