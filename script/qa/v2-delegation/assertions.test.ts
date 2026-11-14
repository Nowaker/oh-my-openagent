import { describe, expect, test } from "bun:test"
import { latestTool } from "./assertions"

describe("latestTool", () => {
  test.each(["ascending", "descending"] as const)("selects the newest matching tool and last matching part from %s native history", (order) => {
    // given
    const history = [
      {
        id: "msg-z-older", type: "assistant", time: { created: 10, completed: 100 },
        content: [{ type: "tool", id: "older-call", name: "execute", time: { created: 1000 }, state: { status: "completed", metadata: { error: false } } }],
      },
      {
        id: "msg-a-newer", type: "assistant", time: { created: 20, completed: 30 },
        content: [
          { type: "tool", id: "newer-first", name: "execute", time: { created: 2000 }, state: { status: "completed", metadata: { error: false } } },
          { type: "text", text: "Tool calls in native part order" },
          { type: "tool", id: "newer-last", name: "execute", time: { created: 1 }, state: {
            status: "completed", content: [{ type: "text", text: "Blocked raw launcher" }], metadata: { error: true },
          } },
          { type: "tool", id: "unrelated-part", name: "shell", state: { status: "completed" } },
        ],
      },
      {
        id: "msg-unrelated", type: "assistant", time: { created: 40 },
        content: [{ type: "tool", id: "unrelated-call", name: "task", state: { status: "completed" } }],
      },
      { id: "msg-idle", type: "idle", time: { created: 50 } },
    ]

    // when
    const call = latestTool({ data: order === "ascending" ? history : history.toReversed() }, "execute")

    // then
    expect(call).toEqual({
      type: "tool", id: "newer-last", name: "execute", time: { created: 1 }, state: {
        status: "completed", content: [{ type: "text", text: "Blocked raw launcher" }], metadata: { error: true },
      },
    })
  })

  test("rejects native history containing only unrelated tools", () => {
    // given
    const history = { data: [{
      id: "msg-unrelated", type: "assistant", time: { created: 10 },
      content: [{ type: "tool", name: "task", state: { status: "completed" } }],
    }] }

    // when / then
    expect(() => latestTool(history, "execute")).toThrow("execute did not execute")
  })
})
