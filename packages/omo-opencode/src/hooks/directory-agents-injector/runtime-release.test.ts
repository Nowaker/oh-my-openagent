import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { createDirectoryAgentsInjectorHook } from "./index"
import { createDirectoryReadmeInjectorHook } from "../directory-readme-injector"
import * as agentsStorage from "./storage"
import * as readmeStorage from "../directory-readme-injector/storage"

let directory = ""
const restoreSpies: Array<() => void> = []
afterEach(() => {
  for (const restore of restoreSpies.splice(0)) restore()
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ""
})

describe("directory injector runtime release", () => {
  test.each(["agents", "readme"] as const)(
    "%s reloads persisted injection bookkeeping without evicting a sibling",
    async (kind) => {
      // given
      directory = mkdtempSync(join(tmpdir(), "directory-runtime-release-"))
      const source = join(directory, "src")
      mkdirSync(source)
      writeFileSync(join(source, kind === "agents" ? "AGENTS.md" : "README.md"), "fixture context")
      const path = join(source, "file.ts")
      writeFileSync(path, "export {}")
      const backing = new Map<string, Set<string>>()
      const storage = kind === "agents" ? agentsStorage : readmeStorage
      const load = spyOn(storage, "loadInjectedPaths").mockImplementation((sessionID: string) => new Set(backing.get(sessionID)))
      const save = spyOn(storage, "saveInjectedPaths").mockImplementation((sessionID: string, paths: Set<string>) => {
        backing.set(sessionID, new Set(paths))
      })
      const clear = spyOn(storage, "clearInjectedPaths").mockImplementation(() => {})
      restoreSpies.push(() => load.mockRestore(), () => save.mockRestore(), () => clear.mockRestore())
      const ctx = unsafeTestValue<PluginInput>({ directory, client: { session: { messages: async () => ({ data: [] }) } } })
      const hook = kind === "agents" ? createDirectoryAgentsInjectorHook(ctx) : createDirectoryReadmeInjectorHook(ctx)
      for (const sessionID of ["directory-retired", "directory-sibling"]) {
        await hook["tool.execute.after"]({ tool: "read", sessionID, callID: sessionID }, { title: path, output: "base", metadata: {} })
      }
      const persisted = new Map([...backing].map(([id, paths]) => [id, new Set(paths)]))
      load.mockClear()

      // when
      hook.releaseSession("directory-retired")
      hook.releaseSession("directory-retired")
      const resumed = { title: path, output: "resumed", metadata: {} }
      const sibling = { title: path, output: "sibling", metadata: {} }
      await hook["tool.execute.after"]({ tool: "read", sessionID: "directory-retired", callID: "resume" }, resumed)
      await hook["tool.execute.after"]({ tool: "read", sessionID: "directory-sibling", callID: "sibling" }, sibling)

      // then
      expect(load.mock.calls).toEqual([["directory-retired"]])
      expect(clear).not.toHaveBeenCalled()
      expect(backing).toEqual(persisted)
      expect(resumed.output).toBe("resumed")
      expect(sibling.output).toBe("sibling")
    },
  )
})
