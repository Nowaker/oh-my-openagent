import { createDelegationPermissionProbes } from "../v2-delegation/permission-scenario"
import { createDelegationProbes } from "../v2-delegation/scenarios"
import { createNativeLifecycleProbes } from "../v2-delegation/native-lifecycle"
import { createNativeJobProbes } from "../v2-delegation/native-jobs"
import { createAllowedLauncherProbes } from "../v2-delegation/native-allowed-launcher"
import { createNativePermissionAskProbe } from "../v2-delegation/native-permission-ask"
import { createNativeRawLauncherProbe } from "../v2-delegation/native-raw-launcher"
import { providerIsolationProbes } from "./provider-isolation"
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
      ...providerIsolationProbes,
      ...bridgeRegressionProbes, baselineProbe(baselineBundle), ...skillsMcpProbes, ...agentConfigProbes, ...claudeLoaderProbes, ...keywordModeProbes,
      ...createDelegationProbes(createScenarioHost, "native"), ...createDelegationPermissionProbes(createScenarioHost, "native"), ...nativeFillProbes,
      ...createAllowedLauncherProbes(createScenarioHost), createNativePermissionAskProbe(createScenarioHost), createNativeRawLauncherProbe(createScenarioHost),
      ...createNativeLifecycleProbes(createScenarioHost), ...createNativeJobProbes(createScenarioHost),
    ],
    rows: [...upstreamRows, ...mustTierRows],
  }
}
