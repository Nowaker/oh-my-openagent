import type { Plugin } from "@opencode-ai/plugin"
import { appendFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"

// Observe the real complete module. No hook is replaced, filtered, or extracted.
const installed = process.env["FULL_PACKAGE_ENTRY"]
const proof = process.env["FULL_PACKAGE_PROOF"]
if (!installed || !proof) throw new Error("Missing isolated package observation paths")
const module = await import(installed)
const plugin: Plugin = module.default.server
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

export const observedPackage: Plugin = async (input) => {
  const hooks = await plugin(input)
  appendFileSync(proof, JSON.stringify({ initialized: true, pid: process.pid, hookCount: Object.keys(hooks).length }) + "\n")
  const original = hooks["chat.message"]
  if (!original) throw new Error("Full package missing chat.message hook")
  return {
    ...hooks,
    "chat.message": async (event, output) => {
      const before = structuredClone(output.parts)
      await original(event, output)
      const unchanged = before.every((part) => output.parts.some((after) => isDeepStrictEqual(part, after)))
      appendFileSync(proof, JSON.stringify({
        pid: process.pid, sessionID: event.sessionID, messageID: output.message.id,
        beforeIDs: before.map((part) => part.id),
        afterIDs: output.parts.map((part) => part.id),
        beforeHash: digest(before),
        retainedHash: digest(output.parts.filter((part) => before.some((old) => old.id === part.id))),
        originalPartsUnchanged: unchanged,
        genuineBefore: before.filter((part) => part.type === "text" && !part.synthetic && !part.ignored).length,
        genuineAfter: output.parts.filter((part) => part.type === "text" && !part.synthetic && !part.ignored).length,
        syntheticAfter: output.parts.filter((part) => part.type === "text" && part.synthetic).length,
      }) + "\n")
    },
  }
}
