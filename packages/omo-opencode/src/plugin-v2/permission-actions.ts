const nativeActions: Readonly<Record<string, string>> = {
  bash: "shell",
  write: "edit",
  apply_patch: "edit",
  task: "subagent",
  call_omo_agent: "subagent",
}

export type PermissionRule = { readonly action: string; readonly resource: string; readonly effect: "allow" | "ask" | "deny" }
export type DelegationOptions = { readonly delegationOwner?: "plugin" | "host" }
const aliases = new Set(Object.values(nativeActions))

function expandPermissionActions(action: string, options: DelegationOptions): readonly string[] {
  if (options.delegationOwner === "host" && (action === "task" || action === "call_omo_agent")) return [action]
  const native = nativeActions[action]
  return native === undefined || native === action ? [action] : [action, native]
}

export function expandPermissionRules(rules: readonly PermissionRule[], options: DelegationOptions = {}): PermissionRule[] {
  const expanded = rules.flatMap((rule) => expandPermissionActions(rule.action, options).map((action) => ({ ...rule, action })))
  const deniedAliases = expanded.filter((rule) => aliases.has(rule.action) && (options.delegationOwner !== "host" || rule.action !== "subagent") && rule.effect === "deny")
  return expanded.filter((rule) => rule.effect === "deny" || !deniedAliases.some((denied) => denied.action === rule.action && denied.resource === rule.resource))
}
