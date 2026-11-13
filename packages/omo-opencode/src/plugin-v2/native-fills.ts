import type { Plugin } from "@opencode/plugin"
import { createHooks, type CreatedHooks } from "../create-hooks"
import type { PluginModuleDeps } from "../testing/create-plugin-module"
import { createNativeInstructions, type NativeInstructions } from "./native-instructions"
import { registerNativeCompaction } from "./native-compaction"
import { registerNativeIdle } from "./native-idle"
import { stopContinuation } from "../plugin/stop-continuation"

type NativeFills = {
  readonly instructions: NativeInstructions
  readonly overrides: Partial<PluginModuleDeps>
  readonly register: () => Promise<Plugin.Cleanup | undefined>
}

export function createNativeFills(ctx: Plugin.Context, base: Partial<PluginModuleDeps> = {}): NativeFills {
  const instructions = createNativeInstructions(ctx)
  const buildHooks = base.createHooks ?? createHooks
  let compactionEnabled = false
  let idleDependencies: Parameters<typeof registerNativeIdle>[1] | undefined
  let stop: ((sessionID: string) => void) | undefined
  const overrides: Partial<PluginModuleDeps> = {
    ...base,
    createHooks: (args) => {
      compactionEnabled = args.isHookEnabled("compaction-context-injector")
      const hooks: CreatedHooks = instructions.wrap(buildHooks({
        ...args,
        isHookEnabled: (name) => name !== "todo-continuation-enforcer" && name !== "compaction-todo-preserver" && name !== "compaction-context-injector" && args.isHookEnabled(name),
      }))
      idleDependencies = { input: args.ctx, enabled: args.isHookEnabled("todo-continuation-enforcer"), isStopped: hooks.stopContinuationGuard?.isStopped }
      if (hooks.stopContinuationGuard) stop = (sessionID) => stopContinuation({ directory: args.ctx.directory, hooks, sessionID })
      return hooks
    },
  }
  const register = async (): Promise<Plugin.Cleanup | undefined> => {
    const cleanups: Plugin.Cleanup[] = []
    try {
      if (compactionEnabled) cleanups.push(await registerNativeCompaction(ctx, instructions))
      if (idleDependencies) cleanups.push(await registerNativeIdle(ctx, idleDependencies))
      if (stop) {
        const stopSession = stop
        const command = await ctx.command.transform((editor) => editor.add({
          name: "stop-continuation",
          description: "Stop automatic OMO continuation for this session",
          execute: async ({ sessionID }) => { stopSession(sessionID) },
        }))
        cleanups.push(() => command.dispose())
      }
    } catch (error) {
      const results = await Promise.allSettled(cleanups.map((cleanup) => cleanup()))
      const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
      if (errors.length > 0) throw new AggregateError([error, ...errors], "Native v2 fill setup and cleanup failed")
      throw error
    }
    return async () => {
      const results = await Promise.allSettled(cleanups.map((cleanup) => cleanup()))
      const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
      if (errors.length > 0) throw new AggregateError(errors, "Native v2 fill cleanup failed")
    }
  }
  return { instructions, overrides, register }
}
