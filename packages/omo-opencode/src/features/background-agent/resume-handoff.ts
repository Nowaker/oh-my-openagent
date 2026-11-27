const capability = Symbol.for("oh-my-openagent.task-resume-handoff.v1")
const MAX_OFFERS = 128
const OFFER_MS = 30_000

type HandoffTarget = { readonly parentSessionId: string; readonly callId: string; readonly childSessionId: string }
export type ResumeHandoff = { readonly commit: () => void; readonly release: (stopped?: boolean) => void }
type Offer = { readonly expiresAt: number; readonly reserve: () => ResumeHandoff | undefined }
const offers = new Map<string, Offer>()

function key(target: HandoffTarget): string {
  return JSON.stringify([target.parentSessionId, target.callId, target.childSessionId])
}

function consume(target: HandoffTarget): ResumeHandoff | undefined {
  if (!target?.parentSessionId || !target.callId || !target.childSessionId) return undefined
  const id = key(target)
  const offer = offers.get(id)
  if (!offer) return undefined
  offers.delete(id)
  return Date.now() <= offer.expiresAt ? offer.reserve() : undefined
}

export function offerTaskResumeHandoff(target: HandoffTarget, reserve: Offer["reserve"]): void {
  const id = key(target)
  const expiresAt = Date.now() + OFFER_MS
  for (const [previous, offer] of offers) {
    if (offer.expiresAt < expiresAt - OFFER_MS || previous === id) offers.delete(previous)
  }
  const oldest = offers.keys().next().value
  if (offers.size >= MAX_OFFERS && oldest !== undefined) offers.delete(oldest)
  offers.set(id, { expiresAt, reserve })
  Reflect.set(globalThis, capability, consume)
}
