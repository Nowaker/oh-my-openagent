import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import type { Sandbox } from "../v2-parity/contracts"

const engineConfig = z.looseObject({ providers: z.looseObject({ fake: z.looseObject({ models: z.record(z.string(), z.json()) }) }) })

export function prepareDelegationFixture(sandbox: Sandbox, instruction: string): void {
  const skill = join(sandbox.project, ".agents/skills/delegation-fixture")
  mkdirSync(skill, { recursive: true })
  writeFileSync(join(skill, "SKILL.md"), `---\nname: delegation-fixture\ndescription: Isolated delegation fixture\n---\n${instruction}\n`)
  const path = join(sandbox.config, "opencode.json")
  const config = engineConfig.parse(JSON.parse(readFileSync(path, "utf8")))
  const fake = config.providers.fake
  writeFileSync(path, JSON.stringify({ ...config, providers: { ...config.providers, fake: { ...fake, models: {
    ...fake.models,
    "child-model": { name: "Delegation child", capabilities: { tools: true }, limit: { context: 200000, output: 8000 }, variants: [{ id: "high", body: { reasoning_effort: "high" } }] },
    "fallback-model": { name: "Unused fallback", capabilities: { tools: true }, limit: { context: 200000, output: 8000 } },
  } } } }))
}

export const delegationConfig = {
  agents: { sisyphus: { model: "fake/fake-model" }, "sisyphus-junior": {}, hephaestus: { model: "fake/gpt-6.1-sol" } },
  categories: { "delegation-fixture": { models: [{ model: "fake/child-model", variant: "high" }, "fake/fallback-model"] } },
} as const
