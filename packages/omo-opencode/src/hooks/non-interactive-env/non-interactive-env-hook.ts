import type { PluginInput } from "@opencode-ai/plugin"
import { getBashEnvDefaults, getBashEnvGuidance, SHELL_COMMAND_PATTERNS } from "./constants"
import type { EditorPolicy } from "./constants"

export * from "./constants"
export * from "./detector"
export * from "./types"

const BANNED_COMMAND_PATTERNS = SHELL_COMMAND_PATTERNS.banned
  .filter((command) => !command.includes("("))
  .map((cmd) => new RegExp(`\\b${cmd}\\b`))

function detectBannedCommand(command: string): string | undefined {
  for (let i = 0; i < BANNED_COMMAND_PATTERNS.length; i++) {
    if (BANNED_COMMAND_PATTERNS[i].test(command)) {
      return SHELL_COMMAND_PATTERNS.banned[i]
    }
  }
  return undefined
}

type ShellEnvInput = {
  readonly cwd: string
  readonly source?: "tool" | "shell" | "pty"
  readonly sessionID?: string
  readonly messageID?: string
  readonly callID?: string
}

export function createNonInteractiveEnvHook(
  _ctx: PluginInput,
  config?: { readonly editor_policy?: EditorPolicy },
) {
  const editorPolicy = config?.editor_policy ?? "fail_closed"
  return {
    "shell.env": async (input: ShellEnvInput, output: { env: Record<string, string> }): Promise<void> => {
      // Older hosts cannot distinguish agent bash from user !shell commands.
      if (input.source !== "tool" || !input.sessionID || !input.messageID || !input.callID) return
      for (const [name, value] of Object.entries(getBashEnvDefaults(editorPolicy))) {
        if (!Object.hasOwn(output.env, name)) output.env[name] = value
      }
    },
    "experimental.chat.system.transform": async (
      _input: unknown,
      output: { system: string[] },
    ): Promise<void> => {
      output.system.push(getBashEnvGuidance(editorPolicy))
    },
    "tool.execute.before": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: Record<string, unknown>; message?: string }
    ): Promise<void> => {
      if (input.tool.toLowerCase() !== "bash") {
        return
      }

      const command = output.args.command
      if (typeof command !== "string" || !command) {
        return
      }

      const bannedCmd = detectBannedCommand(command)
      if (bannedCmd) {
        output.message = `Warning: '${bannedCmd}' is an interactive command that may hang in non-interactive environments.`
      }

    },
  }
}
