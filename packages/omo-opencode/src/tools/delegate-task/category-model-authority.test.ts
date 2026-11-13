import { describe, expect, test } from "bun:test"
import { resolveCategoryConfig } from "./categories"

describe("configured category model authority", () => {
  test.each([false, true])("preserves the configured chain only under runtime authority=%s", (native) => {
    // given
    const models = ["fixture/new-model high", { model: "fixture/known-model", temperature: 0.3 }]
    // when
    const result = resolveCategoryConfig("fixture-lane", {
      userCategories: { "fixture-lane": { models } },
      availableModels: new Set(["fixture/known-model"]),
      preserveConfiguredModels: native,
    })
    // then
    expect(result?.config.models).toEqual(native
      ? ["fixture/new-model high", { model: "fixture/known-model", temperature: 0.3 }]
      : [{ model: "fixture/known-model", temperature: 0.3, variant: undefined }])
  })
})
