import { createHash } from "node:crypto"
import { isSyntheticOrInternalTextPart, stripInternalInitiatorMarkers } from "../../shared/internal-initiator-marker"
import type { PendingParentWake } from "./parent-wake-dedupe"
import type { ParentWakeSessionMessage } from "./parent-wake-session-message"

export type RecoveryPointerIdentity = {
  readonly key: string
  readonly messageID: string
  readonly partID: string
}

const RUN_ID = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
const TERMINAL_NOTICE = /^<system-reminder>\r?\n\[BACKGROUND TASK (?:COMPLETED|CANCELLED|INTERRUPTED|ERROR|GROUP COMPLETE)\]\r?\n/
const TERMINAL_RUN_ID = new RegExp(`^<run-id>(${RUN_ID})</run-id>\\r?$`, "gim")
const OPENCODE_ID_COUNTER_RANGE = 0x1000n
const OPENCODE_ID_TIME_MASK = 0xffffffffffffn
const RECOVERY_HEADER = "[BACKGROUND TASK RESULTS ABOVE]"
const RECOVERY_POINTER = new RegExp(
  `^<system-reminder>\\r?\\n\\[BACKGROUND TASK RESULTS ABOVE\\]\\r?\\n(?:[^<>\\r\\n]+\\r?\\n)*<resume-run-id>(${RUN_ID})</resume-run-id>\\r?\\n</system-reminder>$`,
  "i",
)

export function terminalRunIDs(notification: string): readonly string[] {
  if (!TERMINAL_NOTICE.test(notification)) return []
  const metadata = notification.replace(/<(result|error)>[\s\S]*?<\/\1>/g, "")
  return [...new Set([...metadata.matchAll(TERMINAL_RUN_ID)].flatMap(([, id]) => id ? [id.toLowerCase()] : []))]
}

export function recoveryPointerRunID(notification: string): string | undefined {
  return RECOVERY_POINTER.exec(stripInternalInitiatorMarkers(notification))?.[1]?.toLowerCase()
}

export function recoveryPointerText(runID: string): string {
  return `<system-reminder>
${RECOVERY_HEADER}
A background task notice above still needs your attention.
<resume-run-id>${runID}</resume-run-id>
</system-reminder>`
}

export function observeStoredRunNotices(
  wake: PendingParentWake,
  messages: readonly ParentWakeSessionMessage[] | undefined,
): void {
  if (!messages) return
  const stored = new Set(wake.storedRunNotices)
  const previousCount = stored.size
  for (const notice of wake.notifications) {
    if (stored.has(notice) || terminalRunIDs(notice).length === 0) continue
    const text = stripInternalInitiatorMarkers(notice)
    if (messages.some((message) =>
      (message.info?.role ?? message.role) === "user" &&
      message.parts?.some((part) => isSyntheticOrInternalTextPart(part) && part.text?.includes(text)),
    )) stored.add(notice)
  }
  if (stored.size > previousCount) wake.storedRunNotices = [...stored]
}

export function resolveRecoveryPointerIdentity(input: {
  readonly sessionID: string
  readonly notifications: readonly string[]
  readonly messages: readonly ParentWakeSessionMessage[] | undefined
  readonly previous: RecoveryPointerIdentity | undefined
}): RecoveryPointerIdentity | undefined {
  if (input.notifications.length === 0) return undefined
  const ids = new Set<string>()
  for (const notification of input.notifications) {
    const id = recoveryPointerRunID(notification)
    if (id === undefined) return undefined
    ids.add(id)
  }

  const key = createHash("sha256").update(JSON.stringify([input.sessionID, [...ids].sort()])).digest("hex").slice(0, 24)
  const clock = (BigInt(Date.now()) * OPENCODE_ID_COUNTER_RANGE) & OPENCODE_ID_TIME_MASK
  let order = clock
  for (const message of input.messages ?? []) {
    const messageID = message.info?.id ?? message.id
    if (!messageID) continue
    const encoded = /^msg_([0-9a-f]{12})[A-Za-z0-9]+$/.exec(messageID)?.[1]
    if (!encoded) continue
    if (messageID === `msg_${encoded}${key}` && (message.info?.role ?? message.role) === "user") {
      return { key, messageID, partID: `prt_${encoded}${key}` }
    }
    const position = BigInt(`0x${encoded}`)
    if (position >= order && position < clock + OPENCODE_ID_COUNTER_RANGE - 1n) order = position + 1n
  }
  if (input.previous?.key === key) return input.previous

  const stem = `${order.toString(16).padStart(12, "0")}${key}`
  return { key, messageID: `msg_${stem}`, partID: `prt_${stem}` }
}
