import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"
import { formatAgentsMdContextBlock } from "@oh-my-opencode/agents-md-core"
import { isRealUserTextPart, isSyntheticOrInternalOnlyTextParts } from "@oh-my-opencode/utils"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { createHephaestusAgentsMdInjectorHook } from "./hook"

test("preserves original user part while adding equivalent synthetic directory context", async () => {
  // Given: metadata-bearing input with significant whitespace and independent directory content.
  const root = mkdtempSync(join(tmpdir(), "omo-preserve-"))
  const content = "directory-context-fixture\n"
  const original = { type: "text", text: "[vibeterm_metadata]\ncall: fixture\n[/vibeterm_metadata]\n\n---\n\n  body\twith  spaces \n", id: "prt_original", messageID: "msg_original", sessionID: "ses_original" }
  const snapshot = { ...original }
  const output: { message: { id: string; sessionID: string }; parts: { type: string; text?: string; synthetic?: boolean; id?: string; messageID?: string; sessionID?: string }[] } = { message: { id: "msg_original", sessionID: "ses_original" }, parts: [original] }
  try {
    writeFileSync(join(root, "AGENTS.md"), content)
    const hook = createHephaestusAgentsMdInjectorHook(unsafeTestValue({ directory: root }), undefined, { truncator: { truncate: async (_sid, text) => ({ result: text, truncated: false }) } })
    // When: the actual hook injects first-turn directory instructions.
    await hook["chat.message"]({ sessionID: "ses_original", agent: "hephaestus" }, output)
    // Then: original identity/bytes and genuine classification survive; context remains equivalent.
    expect(original).toEqual(snapshot)
    expect(output.parts).toContain(original)
    expect(output.parts.filter(isRealUserTextPart)).toEqual([original])
    expect(isSyntheticOrInternalOnlyTextParts(output.parts)).toBe(false)
    expect(output.parts.filter((part) => part.synthetic)).toEqual([expect.objectContaining({
      type: "text", synthetic: true, messageID: "msg_original", sessionID: "ses_original",
      text: formatAgentsMdContextBlock({ agentsPath: join(root, "AGENTS.md"), content, truncated: false }) + "\n\n---\n\n",
    })])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("does not turn synthetic-only input into genuine user input", async () => {
  // Given: a synthetic-only continuation with project instructions available.
  const root = mkdtempSync(join(tmpdir(), "omo-synthetic-"))
  const original = { type: "text", text: "synthetic continuation", synthetic: true }
  const output = { message: { id: "msg_synthetic" }, parts: [original] }
  try {
    writeFileSync(join(root, "AGENTS.md"), "context")
    const hook = createHephaestusAgentsMdInjectorHook(unsafeTestValue({ directory: root }))
    // When: the hook receives no genuine user text part.
    await hook["chat.message"]({ sessionID: "ses_synthetic", agent: "hephaestus" }, output)
    // Then: classification and parts are unchanged.
    expect(output.parts).toEqual([original])
    expect(isSyntheticOrInternalOnlyTextParts(output.parts)).toBe(true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
