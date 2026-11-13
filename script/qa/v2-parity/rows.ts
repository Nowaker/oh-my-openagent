import type { MatrixRow } from "./matrix"

const skip = (id: string, label: string, reason: string): MatrixRow => ({ id, label, kind: "unsupported", reason })
const covered = (id: string, label: string, probes: readonly [string, ...string[]], note?: string): MatrixRow =>
  note === undefined ? { id, label, kind: "runtime", probes } : { id, label, kind: "runtime", probes, note }
const config = ["config-project-precedence", "config-profile-precedence", "config-catalog-precedence"] as const
const delegation = ["delegation-foreground", "delegation-background"] as const
const ownedByDelegation = "No runtime probe yet: reserved for the W2 delegation scenarios (script/qa/v2-delegation/), which do not cover this case"

export const upstreamRows: readonly MatrixRow[] = [
  covered("upstream-plugin-load", "#9391 plugin load", ["bridge-directory-loading"]),
  skip("upstream-status-rpc", "#9391 bootstrap RPC omo.status", "The #9391 scaffold's omo.status RPC is not part of the bridge; bridge readiness is the active plugin inventory proved by upstream-plugin-load"),
  skip("upstream-v1-entry", "#9391 V1 host loads the V1 entry unchanged", "This suite drives opencode2 only; the v1 entry is verified by the v1 build and tests of the OMO bump procedure"),
  covered("upstream-tools-glob", "#9391 tools: glob", ["bridge-native-glob-origin", "baseline-native-glob-rejection"]),
  skip("upstream-tools-grep", "#9391 tools: grep", "No runtime probe yet; grep shares glob's native-name override path but is not exercised"),
  skip("upstream-hooks-tool-execute", "#9391 hooks: tool.execute.before/after", "No dedicated runtime probe yet"),
  covered("upstream-hooks-compaction", "#9391 hooks: session compaction", ["native-instructions", "native-overflow"]),
  skip("upstream-hooks-shell", "#9391 hooks: shell create.before", "No runtime probe yet for the non-interactive shell environment"),
  covered("upstream-client-surface", "#9391 client/session/event surface", [...delegation]),
  covered("upstream-agents-listing", "#9391 agents: listing", ["agents-configured-roster", "agents-dynamic-roster"]),
  covered("upstream-agents-dispatch", "#9391 agents: dispatch roundtrip", ["delegation-foreground"]),
  skip("upstream-agents-unknown", "#9391 agents: unknown agent gives a clear error", "No runtime probe yet"),
  skip("upstream-agents-default", "#9391 agents: build/plan demoted, default sisyphus", "No runtime probe yet"),
  covered("upstream-background-collect", "#9391 background task: spawn and collect", ["delegation-background"]),
  skip("upstream-background-error", "#9391 background task: error path does not hang", "No runtime probe yet for a failing background child"),
  covered("upstream-todos", "#9391 todos: write/read roundtrip", ["native-todos"]),
  skip("upstream-mcp-builtin", "#9391 MCP: built-in server injection", "Built-in MCPs need the network (context7, grep_app, websearch) or a language server (lsp); this suite stays offline"),
  covered("upstream-mcp-tools-list", "#9391 MCP: injected server visible via tools/list", ["mcp-v1-registration"]),
  covered("upstream-skills-listing", "#9391 skills: location fallback", ["skills-claude-loader-mcp"]),
  covered("upstream-skills-callable", "#9391 skills: callable from the agent surface", ["skills-claude-loader-mcp", "delegation-foreground"]),
  covered("upstream-config-v1", "#9391 config: V1 config normalizes without rewrite", [...config]),
  skip("upstream-tui", "#9391 TUI: slot claims and keymap", "The OMO TUI plugin is not driven by this server-side suite"),
  skip("upstream-companion-dcp", "#9391 companion: DCP co-loads", "Vibeterm does not load DCP"),
  skip("upstream-companion-tokenscope", "#9391 companion: tokenscope co-loads", "Vibeterm does not load tokenscope"),
  skip("upstream-static-gates", "#9391 static gates: no @opencode-ai/* in the v2 surface", "Does not apply: the bridge deliberately runs the v1 plugin behind a translated v2 entry"),
]

export const mustTierRows: readonly MatrixRow[] = [
  covered("must-agent-roster", "Agent roster and prompt inputs", ["agents-configured-roster", "agents-dynamic-roster", "agents-category-prompt-append"]),
  covered("must-model-authority", "Category, model and variant authority", ["delegation-foreground", "config-catalog-precedence", "agents-category-prompt-append", "agents-model-authority"]),
  covered("must-keyword-modes", "Keyword modes", ["keyword-ultrawork", "keyword-team", "keyword-hyperplan", "keyword-hyperplan-ultrawork"]),
  covered("must-rules-default-mode", "Rules and default mode", ["native-instructions", "native-default-mode"]),
  covered("must-todo-continuation", "Todo continuation and stop", ["native-todos"]),
  covered("must-compaction", "Compaction keeps context and todos", ["native-overflow", "native-instructions"],
    "Known gap, no consumer: a manual compaction that resumes an interrupted active turn does not invoke experimental.idle"),
  covered("must-task-lifecycle", "Task launch and result collection", [...delegation]),
  skip("must-task-resume", "Task resume of the same child through task_id", ownedByDelegation),
  skip("must-task-cancel", "Cancelling an active background child", ownedByDelegation),
  skip("must-task-notice", "Background completion wakes the parent with exactly one notice", ownedByDelegation),
  covered("must-permissions", "Permissions", ["native-permission", "delegation-permission", "delegation-mixed-permission"]),
  covered("must-skills-loaders", "Skills, skill_mcp and loaders", ["skills-claude-loader-mcp", "mcp-v1-registration", "claude-agents-loader", "claude-commands-loader"]),
  covered("must-config", "Configuration compatibility", [...config]),
  covered("regression-seen-ref-codemode", "seen.ref schemas and codemode:false", ["bridge-schema-codemode"]),
  covered("regression-directory-only", "Directory-only plugin loading", ["bridge-directory-loading"]),
  covered("regression-native-glob", "Native glob false positive", ["bridge-native-glob-origin", "baseline-native-glob-rejection"]),
  skip("regression-transform-identity", "messages.transform writes back by identity (SwarmStorm/oh-my-openagent#1)", "No runtime probe yet"),
]
