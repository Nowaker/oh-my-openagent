import { describe, expect, test } from "bun:test"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import type { OpencodeClient } from "./types"
import { buildForkTaskPrompt, isForkSubagent, readParentModel, resolveForkExecution } from "./fork-subagent"

describe("task subagent_type fork", () => {
  test("#given a parent with an agent and a model #when resolved #then the fork runs on both", () => {
    // when
    const resolution = resolveForkExecution({
      sessionID: "ses_parent",
      messageID: "msg_1",
      agent: "Sisyphus - ultraworker",
      model: { providerID: "anthropic", modelID: "claude-opus-5-5", variant: "high" },
    })

    // then
    expect(resolution).toEqual({
      agentToUse: "Sisyphus - ultraworker",
      categoryModel: { providerID: "anthropic", modelID: "claude-opus-5-5", variant: "high" },
    })
  })

  test("#given a parent whose agent is unknown #when resolved #then it is refused", () => {
    expect(resolveForkExecution({ sessionID: "ses_parent", messageID: "msg_1" }).error).toBeString()
  })

  test("#given the subagent_type #when matched #then only fork is a fork, and the task prompt is kept", () => {
    expect(isForkSubagent("fork")).toBe(true)
    expect(isForkSubagent("explore")).toBe(false)
    expect(isForkSubagent(undefined)).toBe(false)
    expect(buildForkTaskPrompt("review the diff in src/")).toContain("review the diff in src/")
  })

  test("#given parent messages #when the parent's model is read #then it is the newest user message's model", async () => {
    // given
    const client = unsafeTestValue<OpencodeClient>({
      session: {
        messages: async () => ({
          data: [
            { info: { role: "user", agent: "build", model: { providerID: "anthropic", modelID: "old" } }, parts: [] },
            { info: { role: "user", agent: "build", model: { providerID: "openai", modelID: "gpt-fake", variant: "high" } }, parts: [] },
          ],
        }),
      },
    })

    // when
    const model = await readParentModel(client, "ses_parent")

    // then
    expect(model).toEqual({ providerID: "openai", modelID: "gpt-fake", variant: "high" })
  })
})
