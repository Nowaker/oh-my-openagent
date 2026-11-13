import { z } from "zod"
import { withNativeHost } from "./v2-native-fills-host"
import { scenarioName } from "./v2-native-fills-contract"
import { permissionScenario } from "./v2-native-fills-permission"
import { todosScenario } from "./v2-native-fills-todos"
import { instructionsScenario } from "./v2-native-fills-instructions"
import { overflowScenario } from "./v2-native-fills-overflow"
import { defaultModeScenario } from "./v2-native-fills-default-mode"

export { permissionScenario } from "./v2-native-fills-permission"
export { todosScenario } from "./v2-native-fills-todos"
export { instructionsScenario } from "./v2-native-fills-instructions"
export { overflowScenario } from "./v2-native-fills-overflow"
export { defaultModeScenario } from "./v2-native-fills-default-mode"
export { withNativeHost } from "./v2-native-fills-host"
export { prepareNativeFixtures } from "./v2-native-fills-fixtures"
export type { DriverOptions, ScenarioHost } from "./v2-native-fills-contract"

if (import.meta.main) {
  const args = z.tuple([z.string(), z.string(), z.string(), scenarioName]).parse(process.argv.slice(2))
  const [evidenceRoot, binary, plugin, scenario] = args
  const scenarios = { permission: permissionScenario, todos: todosScenario, instructions: instructionsScenario, "default-mode": defaultModeScenario, overflow: overflowScenario }
  const result = await withNativeHost<unknown>({ evidenceRoot, binary, plugin, scenario }, scenarios[scenario])
  console.log(JSON.stringify(result))
}
