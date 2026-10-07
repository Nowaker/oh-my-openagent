import { validatePluginConfig, type PluginConfigValidation } from "../../config/validate"
import { memoizeByConfigInputs } from "./config-input-signature"
import { resolveRosterForConfig } from "./roster-resolver"
import type { RosterRow } from "./state-types"

export type SidebarConfigInputs = {
  readonly validation: PluginConfigValidation
  readonly roster: readonly RosterRow[]
}

export function createConfigInputsReader(): (directory: string) => SidebarConfigInputs {
  return memoizeByConfigInputs((directory) => {
    const validation = validatePluginConfig(directory)
    return { validation, roster: resolveRosterForConfig(validation.config) }
  })
}
