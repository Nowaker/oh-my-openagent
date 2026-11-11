import { describe, expect, test } from "bun:test"

import { createSyncSession } from "./sync-session-creator"

describe("createSyncSession", () => {
  test("creates child session with question permission denied", async () => {
    // given
    const createCalls: Array<Record<string, unknown>> = []
    const client = {
      session: {
        get: async () => ({ data: { directory: "/parent" } }),
        create: async (input: Record<string, unknown>) => {
          createCalls.push(input)
          return { data: { id: "ses_child" } }
        },
      },
    }

    // when
    const result = await createSyncSession(client as never, {
      parentSessionID: "ses_parent",
      agentToUse: "explore",
      description: "test task",
      defaultDirectory: "/fallback",
    })

    // then
    expect(result).toEqual({ ok: true, sessionID: "ses_child", parentDirectory: "/parent" })
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]?.body).toEqual({
      parentID: "ses_parent",
      title: "test task (@explore subagent)",
      permission: [
        { permission: "question", action: "deny", pattern: "*" },
      ],
    })
  })

  test("prefixes the category in the child session title", async () => {
    // given
    const createCalls: Array<Record<string, unknown>> = []
    const client = {
      session: {
        get: async () => ({ data: { directory: "/parent" } }),
        create: async (input: Record<string, unknown>) => {
          createCalls.push(input)
          return { data: { id: "ses_child" } }
        },
      },
    }
    const input = {
      parentSessionID: "ses_parent",
      agentToUse: "explore",
      description: "test task",
      defaultDirectory: "/fallback",
      category: "quick",
    }

    // when
    await createSyncSession(client as never, input)

    // then
    const body = createCalls[0]?.body as Record<string, unknown> | undefined
    expect(body?.title).toBe("[quick] test task (@explore subagent)")
  })

  test("#given forkFromParent #when the child is created #then it is a fork of the parent with the question tool denied", async () => {
    // given
    const forkCalls: Array<Record<string, unknown>> = []
    const createCalls: Array<Record<string, unknown>> = []
    const client = {
      session: {
        get: async () => ({ data: { directory: "/parent" } }),
        create: async (input: Record<string, unknown>) => {
          createCalls.push(input)
          return { data: { id: "ses_created" } }
        },
        fork: async (input: Record<string, unknown>) => {
          forkCalls.push(input)
          return { data: { id: "ses_fork" } }
        },
        messages: async () => ({ data: [{ info: { role: "user" } }, { info: { role: "assistant" } }, { info: { role: "user" } }] }),
      },
    }

    // when
    const result = await createSyncSession(client as never, {
      parentSessionID: "ses_parent",
      agentToUse: "sisyphus",
      description: "test task",
      defaultDirectory: "/fallback",
      forkFromParent: true,
    })

    // then
    expect(result).toEqual({ ok: true, sessionID: "ses_fork", parentDirectory: "/parent", anchorMessageCount: 3 })
    expect(createCalls).toHaveLength(0)
    expect(forkCalls[0]?.body).toEqual({
      unsettled: "exclude",
      history: "context",
      parentID: "ses_parent",
      title: "test task (@sisyphus fork)",
      permission: [{ permission: "question", action: "deny", pattern: "*" }],
    })
  })

  test("#given forkFromParent on an opencode without session.fork #when the child is created #then it reports why", async () => {
    // given
    const client = { session: { get: async () => ({ data: { directory: "/parent" } }), create: async () => ({ data: { id: "x" } }) } }

    // when
    const result = await createSyncSession(client as never, {
      parentSessionID: "ses_parent",
      agentToUse: "sisyphus",
      description: "test task",
      defaultDirectory: "/fallback",
      forkFromParent: true,
    })

    // then
    expect(result).toEqual({ ok: false, error: "this opencode cannot fork a session" })
  })
})
