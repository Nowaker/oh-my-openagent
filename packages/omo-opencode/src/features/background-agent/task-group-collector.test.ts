import { describe, expect, test } from "bun:test"
import { TaskGroupCollector } from "./task-group-collector"
import type { BackgroundTask } from "./types"

function member(id: string): BackgroundTask {
  return { id, groupId: "grp_1", parentSessionId: "ses_parent", parentMessageId: "msg", description: id, prompt: "", agent: "explore", status: "completed" }
}

describe("TaskGroupCollector", () => {
  test("#given a group of two #when the first member finishes #then its notice is held", () => {
    // given
    const groups = new TaskGroupCollector()
    groups.register("grp_1", { size: 2, parentSessionId: "ses_parent" })

    // when
    const first = groups.collect(member("bg_a"), "notice-a")

    // then
    expect(first.kind).toBe("hold")
  })

  test("#given a group of two #when the last member finishes #then one notice carries both members in finishing order", () => {
    // given
    const groups = new TaskGroupCollector()
    groups.register("grp_1", { size: 2, parentSessionId: "ses_parent" })
    groups.collect(member("bg_b"), "notice-b")

    // when
    const last = groups.collect(member("bg_a"), "notice-a")

    // then
    expect(last.kind).toBe("deliver")
    const text = last.kind === "deliver" ? last.notification : ""
    expect(text).toContain("[BACKGROUND TASK GROUP COMPLETE]")
    expect(text.indexOf("notice-b")).toBeLessThan(text.indexOf("notice-a"))
    expect(groups.isGrouped(member("bg_a"))).toBe(false)
  })

  test("#given a child failed to launch #when the size settles below what already finished #then the group is released", () => {
    // given
    const groups = new TaskGroupCollector()
    groups.register("grp_1", { size: 3, parentSessionId: "ses_parent" })
    groups.collect(member("bg_a"), "notice-a")
    groups.collect(member("bg_b"), "notice-b")

    // when
    const ready = groups.settleSize("grp_1", 2)

    // then
    expect(ready?.task.id).toBe("bg_b")
    expect(ready?.notification).toContain("notice-a")
    expect(ready?.notification).toContain("notice-b")
  })

  test("#given a task outside any group #when it finishes #then its notice is delivered as is", () => {
    const groups = new TaskGroupCollector()
    expect(groups.collect({ ...member("bg_x"), groupId: undefined }, "solo")).toEqual({ kind: "deliver", notification: "solo" })
  })
})
