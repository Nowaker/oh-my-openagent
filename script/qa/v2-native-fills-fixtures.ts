import { mkdirSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import type { NativeFixtures, ScenarioName } from "./v2-native-fills-contract"

export function prepareNativeFixtures(project: string, scenario: ScenarioName): NativeFixtures {
  switch (scenario) {
    case "permission": {
      const name = "native-permission-proof"
      const marker = `skill-body-${randomUUID()}`
      const directory = join(project, ".agents/skills", name)
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Scratch native permission QA\n---\n${marker}\n`)
      return { scenario, name, marker }
    }
    case "instructions": {
      const marker = `native-rule-${randomUUID()}`
      const path = join(project, "native-fixture.ts")
      mkdirSync(join(project, ".omo/rules"), { recursive: true })
      writeFileSync(join(project, ".omo/rules/native-qa.md"), `---\ndescription: Dynamic W8 rule fixture\nglobs:\n  - "**/native-fixture.ts"\n---\nCarry this runtime fixture into model context: ${marker}\n`)
      writeFileSync(path, "export const fixture = 8\n")
      return { scenario, path, marker, compactionMarker: `native-compaction-${randomUUID()}` }
    }
    case "todos":
    case "default-mode":
    case "overflow": return { scenario }
    default: scenario satisfies never; throw new Error("Unknown native fixture scenario")
  }
}
