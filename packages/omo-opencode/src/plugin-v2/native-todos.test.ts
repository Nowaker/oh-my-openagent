import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { nativeTodos, NativeTodoHistoryUnavailableError, type NativeTodoSession } from "./native-todos"
import type { V2SessionMessage } from "./v1-session-messages"
import { z } from "zod"

type Assistant = Extract<V2SessionMessage, { readonly type: "assistant" }>
type Tool = Extract<Assistant["content"][number], { readonly type: "tool" }>
type Completed = Extract<Tool["state"], { readonly status: "completed" }>

function completed(todos: Completed["input"][string] | undefined): Tool {
  return { type: "tool", id: "call", name: "todowrite", time: { created: 1 }, state: {
    status: "completed", input: { todos: [{ content: "input must not win", status: "pending" }] },
    content: [{ type: "text", text: "Todos updated" }], metadata: todos === undefined ? {} : { todos },
  } }
}

function assistant(id: string, content: Assistant["content"]): Assistant {
  return { type: "assistant", id, time: { created: 1, completed: 2 }, agent: "sisyphus",
    model: { providerID: "provider", id: "model" }, content }
}

function session(messages: readonly V2SessionMessage[]): Pick<Plugin.Context["session"], "context"> {
  return { context: async ({ sessionID }) => {
    expect(sessionID).toBe("session")
    return [...messages]
  } }
}

describe("native todo projection", () => {
  test("ends durable paging at the Promise API's null cursor when no todo exists", async () => {
    // given
    let first = true
    const native: NativeTodoSession = {
      context: async () => { throw new Error("Durable capability must not fall back to compacted context") },
      messages: async ({ cursor }) => {
        if (cursor === undefined) {
          if (!first) throw new Error("Restarted exhausted native paging")
          first = false
          return { data: [assistant("answer", [{ type: "text", text: "No todos were written" }])], cursor: { next: "older" } }
        }
        expect(cursor).toBe("older")
        return { data: [], cursor: { next: null, previous: null } }
      },
    }
    // when
    const todos = await nativeTodos(native, "session")
    // then
    expect(todos).toEqual([])
  })

  test.each([{ todos: [] }, { todos: [{ content: "before compaction", status: "pending" }] }])("recovers the latest durable success through older-page cursors: %j", async ({ todos }) => {
    // given
    const native: NativeTodoSession = {
      context: async () => { throw new Error("Compacted context must not be used when durable messages are supported") },
      messages: async (input) => {
        expect(input.type).toBe("assistant")
        if (input.cursor === undefined) {
          expect(input.order).toBe("desc")
          return { data: [assistant("newer", [{ type: "tool", id: "failed", name: "todowrite", time: { created: 9 },
            state: { status: "error", input: {}, error: { type: "aborted", message: "denied" } } }])], cursor: { next: "older", previous: "newer" } }
        }
        expect(input.cursor).toBe("older")
        expect(input.order).toBeUndefined()
        return { data: [assistant("success", [completed(todos)])], cursor: { next: "must-not-read-stale-todos" } }
      },
    }
    // when
    const result = await nativeTodos(native, "session")
    // then
    expect(result.map(({ content, status }) => ({ content, status }))).toEqual(todos)
  })

  test("selects the last completed call in transcript and tool order, using successful metadata rather than input", async () => {
    // given
    const native = session([
      assistant("old", [completed([{ content: "old", status: "pending" }])]),
      assistant("new", [completed([{ content: "earlier call", status: "completed" }]),
        completed([{ content: "latest", status: "in_progress" }])]),
    ])
    // when
    const todos = await nativeTodos(native, "session")
    // then
    expect(todos).toEqual([{ id: "0", content: "latest", status: "in_progress", priority: "medium" }])
  })

  test.each(["streaming", "running", "error"] as const)("ignores a newer %s call", async (status) => {
    // given
    const input = { todos: [{ content: "not applied", status: "completed" }] }
    const state: Tool["state"] = status === "streaming" ? { status, input: JSON.stringify(input) }
      : status === "running" ? { status, input, metadata: {} }
      : { status, input, error: { type: "aborted", message: "denied" } }
    const native = session([assistant("message", [completed([{ content: "keep", status: "pending" }]),
      { type: "tool", id: "later", name: "todowrite", time: { created: 3 }, state }])])
    // when
    const todos = await nativeTodos(native, "session")
    // then
    expect(todos.map((todo) => todo.content)).toEqual(["keep"])
  })

  test("clears the projection only for a successful empty list", async () => {
    // given
    const native = session([assistant("old", [completed([{ content: "stale", status: "pending" }])]),
      assistant("clear", [completed([])])])
    // when
    const todos = await nativeTodos(native, "session")
    // then
    expect(todos).toEqual([])
  })

  const unusableMetadata: { input: Parameters<typeof completed>[0] }[] = [{ input: undefined }, { input: { todos: [] } }]
  test.each(unusableMetadata)("rejects unusable successful metadata instead of presenting a cleared list: %j", async ({ input }) => {
    const native = session([assistant("old", [completed([{ content: "not cleared", status: "pending" }])]), assistant("bad", [completed(input)])])
    await expect(nativeTodos(native, "session")).rejects.toBeInstanceOf(z.ZodError)
  })

  test("normalizes unknown entries once at the native metadata boundary", async () => {
    // given
    const native = session([assistant("message", [completed([
      null, { content: "" }, { status: "pending" },
      { content: "unknown status", status: "unexpected", priority: "high", id: "native-does-not-own-this" },
      { content: "done", status: "completed" }, { content: "cancelled", status: "cancelled" },
    ])])])
    // when
    const todos = await nativeTodos(native, "session")
    // then
    expect(todos).toEqual([
      { id: "3", content: "unknown status", status: "pending", priority: "medium" },
      { id: "4", content: "done", status: "completed", priority: "medium" },
      { id: "5", content: "cancelled", status: "cancelled", priority: "medium" },
    ])
  })

  test("keeps positional ids stable across wording and status changes", async () => {
    // given
    const native = session([assistant("message", [completed([{ content: "before", status: "pending" }])])])
    const before = await nativeTodos(native, "session")
    native.context = session([assistant("next", [completed([{ content: "after", status: "completed" }])])]).context
    // when
    const after = await nativeTodos(native, "session")
    // then
    expect(after[0]?.id).toBe(before[0]?.id)
    expect(after[0]).toMatchObject({ content: "after", status: "completed" })
  })

  test.each(["auto", "manual"] as const)("reports unavailable history when %s compaction removes the tool from active context", async (reason) => {
    // given
    const native = session([assistant("message", [completed([{ content: "hidden", status: "pending" }])])])
    expect(await nativeTodos(native, "session")).toHaveLength(1)
    native.context = session([{ id: "compacted", type: "compaction", status: "completed", reason,
      time: { created: 4 }, summary: "Tasks remain" }]).context
    // when / then
    await expect(nativeTodos(native, "session")).rejects.toBeInstanceOf(NativeTodoHistoryUnavailableError)
  })

  test("returns an empty list when uncompacted context has no todowrite", async () => {
    // given
    const native = session([assistant("message", [{ type: "text", text: "No work tracked" }])])
    // when
    const todos = await nativeTodos(native, "session")
    // then
    expect(todos).toEqual([])
  })

  test("reads a new native list after a completed compaction", async () => {
    // given
    const native = session([{ id: "compacted", type: "compaction", status: "completed", reason: "auto",
      time: { created: 4 }, summary: "Earlier transcript" },
    assistant("after", [completed([{ content: "current", status: "pending" }])])])
    // when
    const todos = await nativeTodos(native, "session")
    // then
    expect(todos.map((todo) => todo.content)).toEqual(["current"])
  })

  test("propagates context read failure rather than presenting it as a cleared list", async () => {
    // given
    const failure = new Error("context unavailable")
    const native = { context: async () => { throw failure } }
    // when / then
    await expect(nativeTodos(native, "session")).rejects.toBe(failure)
  })
})
