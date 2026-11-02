import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import * as spawnModule from "../../shared/spawn-with-windows-hide"
import { subagentSessions } from "../../features/claude-code-session-state"
import { createInteractiveBashSessionHook } from "./index"
import * as storage from "./storage"

const restoreSpies: Array<() => void> = []
afterEach(() => {
  for (const restore of restoreSpies.splice(0)) restore()
  subagentSessions.delete("interactive-sibling")
})

describe("interactive bash runtime release", () => {
  test("releases only owned tmux resources and preserves a resumed entry during cleanup", async () => {
    // given
    const abort = mock(async () => undefined)
    const hook = createInteractiveBashSessionHook(unsafeTestValue<PluginInput>({
      client: { session: { abort } },
    }))
    const load = spyOn(storage, "loadInteractiveBashSessionState").mockReturnValue(null)
    const save = spyOn(storage, "saveInteractiveBashSessionState").mockImplementation(() => {})
    const clear = spyOn(storage, "clearInteractiveBashSessionState").mockImplementation(() => {})
    const exit = Promise.withResolvers<number>()
    const killed: string[][] = []
    const spawn = spyOn(spawnModule, "spawnWithWindowsHide").mockImplementation((command) => {
      killed.push([...command])
      return unsafeTestValue({ exited: killed.length === 1 ? exit.promise : Promise.resolve(0) })
    })
    restoreSpies.push(() => load.mockRestore(), () => save.mockRestore(), () => clear.mockRestore(), () => spawn.mockRestore())
    subagentSessions.add("interactive-sibling")
    for (const [sessionID, name] of [["interactive-retired", "omo-owned"], ["interactive-sibling", "omo-sibling"]]) {
      await hook["tool.execute.after"]({
        tool: "interactive_bash", sessionID, callID: name,
        args: { tmux_command: `new-session -d -s ${name}` },
      }, { title: "", output: "", metadata: {} })
    }
    load.mockClear()
    save.mockClear()

    // when - install a new runtime while the old owned tmux process is exiting
    const release = hook.releaseSession("interactive-retired")
    try {
      await hook["tool.execute.after"]({
        tool: "interactive_bash", sessionID: "interactive-retired", callID: "resume",
        args: { tmux_command: "new-session -d -s omo-resumed" },
      }, { title: "", output: "", metadata: {} })
    } finally {
      exit.resolve(0)
      await release
    }

    // then
    expect(killed).toEqual([["tmux", "kill-session", "-t", "omo-owned"]])
    expect(abort).not.toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
    expect(load.mock.calls).toEqual([["interactive-retired"]])
    expect(save.mock.calls[0]?.[0].tmuxSessions).toEqual(new Set(["omo-resumed"]))
    await hook.releaseSession("interactive-retired")
    await hook.releaseSession("interactive-retired")
    expect(killed).toEqual([
      ["tmux", "kill-session", "-t", "omo-owned"],
      ["tmux", "kill-session", "-t", "omo-resumed"],
    ])
    await hook.releaseSession("interactive-sibling")
    expect(killed[2]).toEqual(["tmux", "kill-session", "-t", "omo-sibling"])
  })
})
