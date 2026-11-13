import { describe, expect, test } from "bun:test"
import { buildDelegatedPrompt } from "./delegated-prompt"
import { markNativeDelegationClient } from "../../shared/native-delegation-client"

describe("delegated prompt wire identity", () => {
  test.each([false, true])("preserves the selected child authority with native=%s", (native) => {
    // given
    const client = native ? markNativeDelegationClient({}) : {}
    // when
    const result = buildDelegatedPrompt(client, { agent: "Sisyphus-Junior", prompt: "Search the fixture", skillContent: "Fixture skill" }, {
      model: { providerID: "fixture", modelID: "chosen" }, variant: "high", tools: { question: false },
    })
    // then
    expect(result).toMatchObject({ agent: native ? "sisyphus-junior" : "Sisyphus-Junior", model: { providerID: "fixture", modelID: "chosen" }, variant: "high", system: "Fixture skill", tools: { question: false } })
    expect(result.parts[0]?.text).toBe("Search the fixture\n<!-- OMO_INTERNAL_INITIATOR -->")
  })
})
