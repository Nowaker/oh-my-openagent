import { ALLOWED_AGENTS } from "../tools/call-omo-agent/constants"
import { getAgentConfigKey } from "../shared/agent-display-names"
import type { PermissionRule } from "./permission-actions"

function matchesAction(action: string, pattern: string): boolean {
  const expression = Array.from(pattern, (character) => character === "*" ? ".*" : character === "?" ? "." : RegExp.escape(character)).join("")
  return new RegExp(`^${expression}$`, process.platform === "win32" ? "is" : "s").test(action)
}

export function nativeBackendRules(rules: readonly PermissionRule[]): PermissionRule[] {
  return rules.filter((rule) => matchesAction("subagent", rule.action)).map((rule) => ({ ...rule, action: "subagent" }))
}

function hostDelegationAllows(rules: readonly PermissionRule[]): PermissionRule[] {
  const allowed = (action: string): boolean => {
    const rule = rules.findLast((entry) => matchesAction(action, entry.action))
    return !(rule?.resource === "*" && rule.effect === "deny")
  }
  return [
    ...(allowed("task") ? [{ action: "subagent", resource: "*", effect: "allow" as const }] : []),
    ...(allowed("call_omo_agent") ? ALLOWED_AGENTS.map((agent) => ({ action: "subagent", resource: getAgentConfigKey(agent), effect: "allow" as const })) : []),
  ]
}

export function projectHostPermissionRules(rules: readonly PermissionRule[], native: readonly PermissionRule[] = []): PermissionRule[] {
  return [...hostDelegationAllows(rules), ...nativeBackendRules(native), ...rules]
}

export function mergeHostPermissionRules(rules: readonly PermissionRule[], authority: {
  readonly agent: readonly PermissionRule[]; readonly session: readonly PermissionRule[];
}): PermissionRule[] {
  const previous = authority.session
  const merged = [...previous.filter((rule) => rule.effect !== "deny"), ...rules, ...previous.filter((rule) => rule.effect === "deny")]
  const backend = nativeBackendRules([...authority.agent, ...previous, ...rules])
  const ordinary = merged.filter((rule) => rule.action !== "subagent")
  const projected = rules.some((rule) => matchesAction("task", rule.action) || matchesAction("call_omo_agent", rule.action))
    ? hostDelegationAllows([...authority.agent, ...merged]) : []
  return [...projected, ...ordinary, ...backend]
}
