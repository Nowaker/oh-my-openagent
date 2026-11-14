import type { SessionPromptData } from "@opencode-ai/sdk"
import type { Plugin } from "@opencode/plugin"
import { normalizeAgentForPromptKey } from "../shared/agent-display-names"
import { unsupportedV1Call } from "./v1-client-errors"
import { applyPromptAuthority } from "./v1-session-authority"
import type { V1SessionContext } from "./v1-session"
import type { DelegationOptions } from "./permission-actions"

type NativeSession = Plugin.Context["session"]
type UserInput = Parameters<NativeSession["prompt"]>[0]
type SyntheticInput = Parameters<NativeSession["synthetic"]>[0]
export type PromptBody = NonNullable<SessionPromptData["body"]> & { readonly variant?: string }
export type PromptInput = { readonly path: { readonly id: string }; readonly body?: PromptBody }
export type AdmissionReceipt = Awaited<ReturnType<NativeSession["prompt"]>> | Awaited<ReturnType<NativeSession["synthetic"]>>
type PromptAdmission = { readonly type: "user"; readonly input: UserInput } | { readonly type: "synthetic"; readonly input: SyntheticInput }

export function promptPayload(input: PromptInput, method: string): PromptAdmission {
  const body = input.body
  if (!body) return unsupportedV1Call(`${method}.body`)
  const text: string[] = []
  const files: NonNullable<UserInput["files"]>[number][] = []
  const agents: NonNullable<UserInput["agents"]>[number][] = []
  const synthetic = body.parts.some((part) => part.type === "text" && part.synthetic === true)
  for (const part of body.parts) {
    if (synthetic && (part.type !== "text" || part.synthetic !== true)) return unsupportedV1Call(`${method}.parts.mixed-synthetic`)
    switch (part.type) {
      case "text":
        if (part.ignored || part.metadata !== undefined || part.time !== undefined) return unsupportedV1Call(`${method}.parts.text`)
        text.push(part.text)
        break
      case "file":
        if (part.source !== undefined) return unsupportedV1Call(`${method}.parts.file.source`)
        files.push({ uri: part.url, name: part.filename })
        break
      case "agent": {
        const name = normalizeAgentForPromptKey(part.name)
        if (name === undefined) return unsupportedV1Call(`${method}.parts.agent.name`)
        agents.push({ name, ...(part.source ? { mention: { start: part.source.start, end: part.source.end, text: part.source.value } } : {}) })
        break
      }
      case "subtask": return unsupportedV1Call(`${method}.parts.subtask`)
      default: return assertExhaustive(part)
    }
  }
  const common = { sessionID: input.path.id, id: body.messageID, text: text.join("\n\n"), resume: !body.noReply }
  return synthetic ? { type: "synthetic", input: common } : { type: "user", input: { ...common, files, agents } }
}

function assertExhaustive(value: never): never {
  throw new TypeError("Unrecognized v1 prompt part")
}

export function createPromptAdmission(ctx: V1SessionContext, options: DelegationOptions = {}): (input: PromptInput, method: string) => Promise<AdmissionReceipt> {
  const admissions = new Map<string, Promise<void>>()
  return async (input, method) => {
    const payload = promptPayload(input, method)
    const previous = admissions.get(input.path.id) ?? Promise.resolve()
    const operation = previous.then(async () => {
      await applyPromptAuthority(ctx, input, { ...options, method })
      switch (payload.type) {
        case "user": return ctx.session.prompt(payload.input)
        case "synthetic": return ctx.session.synthetic(payload.input)
        default: return assertExhaustive(payload)
      }
    })
    const settled = operation.then(() => undefined, () => undefined)
    admissions.set(input.path.id, settled)
    void settled.then(() => { if (admissions.get(input.path.id) === settled) admissions.delete(input.path.id) })
    return operation
  }
}
