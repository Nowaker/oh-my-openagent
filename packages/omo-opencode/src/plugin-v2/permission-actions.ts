const nativeActions: Readonly<Record<string, string>> = {
  bash: "shell",
  write: "edit",
  apply_patch: "edit",
  task: "subagent",
  call_omo_agent: "subagent",
}

type PermissionRule = { readonly action: string; readonly resource: string; readonly effect: "allow" | "ask" | "deny" }
const aliases = new Set(Object.values(nativeActions))

function expandPermissionActions(action: string): readonly string[] {
  const native = nativeActions[action]
  return native === undefined || native === action ? [action] : [action, native]
}

export function expandPermissionRules(rules: readonly PermissionRule[]): PermissionRule[] {
  const expanded = rules.flatMap((rule) => expandPermissionActions(rule.action).map((action) => ({ ...rule, action })))
  const deniedAliases = expanded.filter((rule) => aliases.has(rule.action) && rule.effect === "deny")
  return expanded.filter((rule) => rule.effect === "deny" || !deniedAliases.some((denied) => denied.action === rule.action && denied.resource === rule.resource))
}
