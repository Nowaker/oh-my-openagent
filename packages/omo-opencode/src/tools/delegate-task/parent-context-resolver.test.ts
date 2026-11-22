import { expect, test } from "bun:test"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { resolveParentContext } from "./parent-context-resolver"
import type { ToolContextWithMetadata } from "./types"

test("delegate tools inherit the effective parent model rather than reading preferred history", async () => {
  const input = {
    sessionID: "ses_effective_parent",
    messageID: "msg_effective_parent",
    agent: "hephaestus",
    abort: new AbortController().signal,
    autoSwitch: {
      version: 1,
      preferred: { agent: "sisyphus", providerID: "anthropic", modelID: "claude-opus-5-5", variant: "high" },
      effective: { agent: "hephaestus", providerID: "openai", modelID: "gpt-6.2-sol", variant: "xhigh" },
    },
  } satisfies ToolContextWithMetadata & { autoSwitch: unknown }
  const result = await resolveParentContext(
    input,
    unsafeTestValue({
      session: {
        messages: async () => {
          throw new Error("effective parent must not consult preferred history")
        },
      },
    }),
  )

  expect(result).toEqual({
    sessionID: input.sessionID,
    messageID: input.messageID,
    agent: "hephaestus",
    model: { providerID: "openai", modelID: "gpt-6.2-sol", variant: "xhigh" },
  })
})
