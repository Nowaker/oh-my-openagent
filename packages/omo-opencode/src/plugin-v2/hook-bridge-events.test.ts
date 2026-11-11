import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk"
import { Location } from "@opencode/plugin"
import { buildV1EventView, subscribeV1Events } from "./hook-bridge-events"
import type { NativeEvent } from "./hook-bridge-types"

const ctx = { session: { context: async () => [] }, location: { directory: Location.Info.fields.directory.make("/scratch/project") } }

describe("v2 lifecycle hook translation", () => {
  test.each(["session.execution.succeeded", "session.execution.started", "session.idle"] as const)("maps only a real idle event for %s", async (type) => {
    const event: NativeEvent = { id: "event", created: 10, type, data: { sessionID: "session" }, durable: { aggregateID: "session", seq: 1, version: 1 } }
    const translated = await buildV1EventView(ctx, event, new Map())
    expect(translated).toEqual(type === "session.idle" ? { type: "session.idle", properties: { sessionID: "session" } } : undefined)
  })

  test("retains session identity on deletion using the observed creation record", async () => {
    const cache = new Map<string, Session>()
    await buildV1EventView(ctx, {
      id: "created", created: 10, type: "session.created", durable: { aggregateID: "session", seq: 1, version: 1 },
      data: { sessionID: "session", projectID: "project", slug: "slug", version: "2.2.7", title: "Title", parentID: "parent", location: { directory: "/scratch/project" } },
    }, cache)
    const result = await buildV1EventView(ctx, {
      id: "deleted", created: 20, type: "session.deleted", durable: { aggregateID: "session", seq: 2, version: 2 }, data: { sessionID: "session" },
    }, cache)
    expect(result).toEqual({ type: "session.deleted", properties: { info: {
      id: "session", projectID: "project", directory: "/scratch/project", parentID: "parent", title: "Title", version: "2.2.7", time: { created: 10, updated: 10 },
    } } })
  })

  test("aborts and settles the subscription on cleanup", async () => {
    let stopped = false
    const event = { subscribe: async function* (options?: { readonly signal?: AbortSignal }) {
      try {
        await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }))
      } finally { stopped = true }
    } }
    const cleanup = subscribeV1Events({ ...ctx, event }, async () => {})
    await cleanup()
    expect(stopped).toBe(true)
  })
})
