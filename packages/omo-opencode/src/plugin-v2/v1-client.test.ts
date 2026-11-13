import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { createV1ClientAdapter } from "./v1-client"
import { createClientFixture } from "./v1-client-fixture.test"
import type { Plugin } from "@opencode/plugin"
import * as logger from "../shared/logger"

describe("v1 client throwing facade", () => {
  let captured: { message: string; data: unknown }[]
  beforeEach(() => {
    captured = []
    const actual = { ...logger }
    mock.module("../shared/logger", () => ({
      ...actual,
      log: (message: string, data: unknown) => { captured.push({ message, data }) },
    }))
  })
  afterEach(() => {
    mock.restore()
  })
  test.each(["get", "showToast"] as const)("logs and rejects an unavailable %s call without payload content", async (method) => {
    const { ctx } = createClientFixture()
    const client = createV1ClientAdapter(ctx)

    const result = method === "get" ? client.config.get() : client.tui.showToast()

    const path = method === "get" ? "config.get" : "tui.showToast"
    await expect(result).rejects.toMatchObject({ name: "UnsupportedV1ClientCallError", message: path, method: path })
    expect(captured).toEqual([{ message: "[v2-bridge] unsupported v1 call", data: { method: path } }])
  })

  test("throws the complete method path for an unknown nested method", () => {
    const { ctx } = createClientFixture()
    const client = createV1ClientAdapter(ctx)
    const missing: unknown = Reflect.get(client.session, "newMethod")
    if (typeof missing !== "function") throw new TypeError("Expected unknown method proxy")

    expect(() => missing({ body: "private content" })).toThrow("session.newMethod")

    expect(captured).toEqual([{ message: "[v2-bridge] unsupported v1 call", data: { method: "session.newMethod" } }])
  })

  test("returns actual host app metadata", async () => {
    const { ctx } = createClientFixture()
    const client = createV1ClientAdapter(ctx)

    const result = await client.app.get()

    expect(result.data).toEqual({ name: "opencode", version: "2.2.7", channel: "stable" })
  })

  test("projects provider availability, model limits and the real default from native registries", async () => {
    const { ctx } = createClientFixture()
    const requestAuthorization = `fixture-${crypto.randomUUID()}`
    const model: Awaited<ReturnType<Plugin.Context["model"]["list"]>>["data"][number] = {
      id: "chat", modelID: "upstream-chat", providerID: "ready", name: "Chat",
      settings: { apiKey: requestAuthorization }, headers: { authorization: "fixture-model-auth" },
      capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [{ id: "high", body: { reasoning_effort: "high" }, headers: { authorization: "fixture-variant-auth" } }], time: { released: 0 }, cost: [], status: "active", enabled: true, limit: { context: 128000, output: 4096 },
    }
    ctx.model.list = async () => ({ location: ctx.location, data: [model, { ...model, id: "hidden", providerID: "offline", enabled: false }] })
    ctx.model.default = async () => ({ location: ctx.location, data: model })
    ctx.provider.list = async () => ({ location: ctx.location, data: [
      { id: "ready", name: "Ready", activation: "enabled", package: "@ai-sdk/openai-compatible" },
      { id: "offline", name: "Offline", activation: "disabled", package: "@ai-sdk/openai-compatible" },
    ] })
    const client = createV1ClientAdapter(ctx)

    const result = await client.provider.list()

    expect(result.data.connected).toEqual(["ready"])
    expect(result.data.default).toEqual({ ready: "chat" })
    expect(result.data.all[0]?.models.chat?.limit).toEqual({ context: 128000, output: 4096 })
    expect(result.data.all[1]?.models.hidden?.enabled).toBe(false)
    const listed = await client.model.list()
    expect(JSON.stringify([result, listed])).not.toContain(requestAuthorization)
    expect(JSON.stringify([result, listed])).not.toContain("fixture-model-auth")
    expect(JSON.stringify([result, listed])).not.toContain("fixture-variant-auth")
    expect(result.data.all[0]?.models.chat?.variants).toEqual({ high: { id: "high" } })
    expect(listed.data[0]?.variants).toEqual({ high: { id: "high" } })
  })
})
