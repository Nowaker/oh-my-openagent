import { describe, test, expect } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { OhMyOpenCodeConfigSchema } from "../../config/schema"
import { createNonInteractiveEnvHook } from "./index"

const context = {} as PluginInput
const agentInput = { cwd: ".", source: "tool", sessionID: "session", messageID: "message", callID: "call" } as const

describe("non-interactive-env hook", () => {
  test.each([
    "git commit -m 'test'",
    "GIT_EDITOR=custom git status && printf '%s' \"$GIT_EDITOR\"",
    "printf '%s' git",
    "ls -la",
    "vim file.txt",
    "",
  ])("#given raw bash command %s #when pre-tool hook runs #then arguments remain unchanged", async (command) => {
    const hook = createNonInteractiveEnvHook(context)
    const args = { command, description: "original", timeout: 123 }
    const output = { args }
    await hook["tool.execute.before"]({ tool: "bash", sessionID: "session", callID: "call" }, output)
    expect(output.args).toBe(args)
    expect(output.args).toEqual({ command, description: "original", timeout: 123 })
  })

  test("#given interactive command #when pre-tool hook runs #then warns without rewriting", async () => {
    const hook = createNonInteractiveEnvHook(context)
    const output: { args: Record<string, unknown>; message?: string } = { args: { command: "vim file.txt" } }
    await hook["tool.execute.before"]({ tool: "bash", sessionID: "session", callID: "call" }, output)
    expect(output.message).toBeDefined()
    expect(output.args.command).toBe("vim file.txt")
  })

  test("#given earlier explicit plugin env #when agent overlay runs #then preserves values and object identity", async () => {
    const hook = createNonInteractiveEnvHook(context)
    const env = { GIT_EDITOR: "custom-editor", PAGER: "", OTHER: "keep" }
    const output = { env }
    await hook["shell.env"](agentInput, output)
    expect(output.env).toBe(env)
    expect(output.env.GIT_EDITOR).toBe("custom-editor")
    expect(output.env.PAGER).toBe("")
    expect(output.env.OTHER).toBe("keep")
  })

  test.each([
    { cwd: ".", source: "pty" },
    { ...agentInput, source: "shell" },
    { cwd: "." },
    { ...agentInput, source: undefined },
    { ...agentInput, messageID: undefined },
    { ...agentInput, callID: undefined },
    { ...agentInput, sessionID: undefined },
  ] as const)("#given non-agent or incomplete identity %j #when shell hook runs #then adds nothing", async (input) => {
    const hook = createNonInteractiveEnvHook(context)
    const output = { env: { KEEP: "original" } }
    await hook["shell.env"](input, output)
    expect(output.env).toEqual({ KEEP: "original" })
  })

  test("#given inherited editor policy config #when parsed and applied #then editor env remains inherited", async () => {
    const config = OhMyOpenCodeConfigSchema.parse({ non_interactive_env: { editor_policy: "inherit" } })
    const hook = createNonInteractiveEnvHook(context, config.non_interactive_env)
    const output: { env: Record<string, string> } = { env: {} }
    await hook["shell.env"](agentInput, output)
    expect(output.env).toEqual({ GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_PAGER: "cat", PAGER: "cat", PIP_NO_INPUT: "1" })
  })

  test.each([
    ["printf '%s' \"$PAGER:$PIP_NO_INPUT:$GIT_EDITOR\"", "cat:1:false", 0],
    ["git var GIT_EDITOR", "false\n", 0],
    ["PAGER=override sh -c 'printf %s \"$PAGER\"'", "override", 0],
    ["export GIT_EDITOR=override; git var GIT_EDITOR", "override\n", 0],
    ["env -i /bin/sh -c 'printf %s \"${PAGER-unset}\"'", "unset", 0],
    ["$GIT_EDITOR", "", 1],
  ] as const)("#given real bash child #when executing %s #then observes policy", async (command, stdout, exitCode) => {
    const hook = createNonInteractiveEnvHook(context)
    const output: { env: Record<string, string> } = { env: {} }
    await hook["shell.env"](agentInput, output)
    const result = Bun.spawnSync(["bash", "--noprofile", "--norc", "-c", command], {
      env: { PATH: process.env.PATH, PAGER: "host-pager", GIT_EDITOR: "host-editor", ...output.env },
    })
    expect(result.exitCode).toBe(exitCode)
    expect(result.stdout.toString()).toBe(stdout)
  })
})
