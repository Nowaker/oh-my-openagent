export const HOOK_NAME = "non-interactive-env"

export type EditorPolicy = "fail_closed" | "inherit"

type EnvironmentDefault = {
  readonly name: string
  readonly value: string
  readonly preset: "core" | "editor"
}

export const BASH_ENV_DEFAULTS = [
  { name: "GIT_TERMINAL_PROMPT", value: "0", preset: "core" },
  { name: "GCM_INTERACTIVE", value: "never", preset: "core" },
  { name: "GIT_PAGER", value: "cat", preset: "core" },
  { name: "PAGER", value: "cat", preset: "core" },
  { name: "PIP_NO_INPUT", value: "1", preset: "core" },
  { name: "GIT_EDITOR", value: "false", preset: "editor" },
  { name: "GIT_SEQUENCE_EDITOR", value: "false", preset: "editor" },
  { name: "EDITOR", value: "false", preset: "editor" },
  { name: "VISUAL", value: "false", preset: "editor" },
] as const satisfies readonly EnvironmentDefault[]

export function getBashEnvDefaults(editorPolicy: EditorPolicy): Record<string, string> {
  return Object.fromEntries(BASH_ENV_DEFAULTS
    .filter((entry) => entry.preset === "core" || editorPolicy === "fail_closed")
    .map(({ name, value }) => [name, value]))
}

export function getBashEnvGuidance(editorPolicy: EditorPolicy): string {
  const defaults = Object.entries(getBashEnvDefaults(editorPolicy))
    .map(([name, value]) => `${name}=${value}`).join(" ")
  return `On hosts with source-tagged shell.env, agent bash children receive ${defaults} as environment defaults, not command prefixes. Explicit environment overlays and shell assignments override them; user shells and PTYs are unchanged. ${editorPolicy === "fail_closed" ? "Editors fail closed: provide messages/files or explicitly select an editor; false does not approve an empty edit. " : "Editor settings are inherited. "}Do not repeat these defaults in commands. env -i, sudo, and SSH may clear them; opt in to operation-specific CI, package-manager, or merge settings only when needed.`
}

/**
 * Shell command guidance for non-interactive environments.
 * These patterns should be followed to avoid hanging on user input.
 */
export const SHELL_COMMAND_PATTERNS = {
  // Package managers - always use non-interactive flags
  npm: {
    bad: ["npm init", "npm install (prompts)"],
    good: ["npm init -y", "npm install --yes"],
  },
  apt: {
    bad: ["apt-get install pkg"],
    good: ["apt-get install -y pkg", "DEBIAN_FRONTEND=noninteractive apt-get install pkg"],
  },
  pip: {
    bad: ["pip install pkg (with prompts)"],
    good: ["pip install --no-input pkg", "PIP_NO_INPUT=1 pip install pkg"],
  },
  // Git operations - always provide messages/flags
  git: {
    bad: ["git commit", "git merge branch", "git add -p", "git rebase -i"],
    good: ["git commit -m 'msg'", "git merge --no-edit branch", "git add .", "git rebase --no-edit"],
  },
  // System commands - force flags
  system: {
    bad: ["rm file (prompts)", "cp a b (prompts)", "ssh host"],
    good: ["rm -f file", "cp -f a b", "ssh -o BatchMode=yes host", "unzip -o file.zip"],
  },
  // Banned commands - will always hang
  banned: [
    "vim", "nano", "vi", "emacs",           // Editors
    "less", "more", "man",                   // Pagers
    "python (REPL)", "node (REPL)",          // REPLs without -c/-e
    "git add -p", "git rebase -i",           // Interactive git modes
  ],
  // Workarounds for scripts that require input
  workarounds: {
    yesPipe: "yes | ./script.sh",
    heredoc: `./script.sh <<EOF
option1
option2
EOF`,
    expectAlternative: "Use environment variables or config files instead of expect",
  },
} as const
