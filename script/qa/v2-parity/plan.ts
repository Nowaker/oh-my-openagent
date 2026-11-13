import { createDelegationPermissionProbes } from "../v2-delegation/permission-scenario"
import { createDelegationProbes } from "../v2-delegation/scenarios"
import { agentConfigProbes } from "./agent-config"
import { baselineProbe } from "./baseline"
import { bridgeRegressionProbes } from "./bridge-regressions"
import { claudeLoaderProbes } from "./claude-loaders"
import { createScenarioHost } from "./harness"
import { keywordModeProbes } from "./keyword-modes"
import { nativeFillProbes } from "./native-fills"
import { mustTierRows, upstreamRows } from "./rows"
import { skillsMcpProbes } from "./skills-mcp"
import type { ParityPlan } from "./suite"

export function parityPlan(baselineBundle: string | undefined): ParityPlan {
  return {
    probes: [
      ...bridgeRegressionProbes, baselineProbe(baselineBundle), ...skillsMcpProbes, ...agentConfigProbes, ...claudeLoaderProbes, ...keywordModeProbes,
      ...createDelegationProbes(createScenarioHost), ...createDelegationPermissionProbes(createScenarioHost), ...nativeFillProbes,
    ],
    rows: [...upstreamRows, ...mustTierRows],
  }
}
