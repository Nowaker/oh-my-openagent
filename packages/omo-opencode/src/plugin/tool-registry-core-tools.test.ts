import { describe, expect, mock, test } from "bun:test"
import { tool } from "@opencode-ai/plugin"
import type { SkillLoadOptions } from "../tools/skill/types"
import type { ToolRegistryFactories } from "./tool-registry-factories"

import { unsafeTestValue } from "../../../../test-support/unsafe-test-value"
import { createCoreTools } from "./tool-registry-core-tools"
import { createTeamModeToolsRecord } from "./tool-registry-team-tools"
import { createManagers, UnsupportedHostDelegationError } from "../create-managers"
import { OhMyOpenCodeConfigSchema } from "../config/schema/oh-my-opencode-config"
import { createHostDelegationFixture } from "../testing/host-delegation-test-fixture"

const fakeTool = tool({
  description: "fake tool",
  args: {},
  async execute(): Promise<string> {
    return "ok"
  },
})

function createFactories(createSkillTool: (options: SkillLoadOptions) => typeof fakeTool): ToolRegistryFactories {
  return {
    createBackgroundTools: () => ({}),
    createCallOmoAgent: () => fakeTool,
    createLookAt: () => fakeTool,
    createMonitorTools: () => ({}),
    createSkillMcpTool: () => fakeTool,
    createSkillTool,
    createGrepTools: () => ({}),
    createGlobTools: () => ({}),
    createSessionManagerTools: () => ({}),
    createDelegateTask: () => fakeTool,
    discoverCommandsSync: () => [],
    interactive_bash: fakeTool,
    createTaskCreateTool: () => fakeTool,
    createTaskGetTool: () => fakeTool,
    createTaskList: () => fakeTool,
    createTaskUpdateTool: () => fakeTool,
    createHashlineEditTool: () => fakeTool,
    createTeamApproveShutdownTool: () => fakeTool,
    createTeamCreateTool: () => fakeTool,
    createTeamDeleteTool: () => fakeTool,
    createTeamRejectShutdownTool: () => fakeTool,
    createTeamShutdownRequestTool: () => fakeTool,
    createTeamSendMessageTool: () => fakeTool,
    createTeamTaskCreateTool: () => fakeTool,
    createTeamTaskGetTool: () => fakeTool,
    createTeamTaskListTool: () => fakeTool,
    createTeamTaskUpdateTool: () => fakeTool,
    createTeamStatusTool: () => fakeTool,
    createTeamListTool: () => fakeTool,
  }
}

describe("#given disabled native skills in the registry skill context", () => {
  test("#when core tools register the skill tool #then disabled skills are passed to the skill tool factory", () => {
    // given
    const disabledSkills = new Set(["native-security-skill"])
    const createSkillTool = mock((options: SkillLoadOptions) => fakeTool)

    // when
    createCoreTools({
      ctx: unsafeTestValue({ directory: "/tmp/project" }),
      pluginConfig: unsafeTestValue({
        disabled_agents: ["multimodal-looker"],
      }),
      managers: unsafeTestValue({
        backgroundManager: {},
        tmuxSessionManager: {},
        skillMcpManager: {},
        modelFallbackControllerAccessor: {},
      }),
      skillContext: {
        mergedSkills: [],
        availableSkills: [],
        browserProvider: "playwright",
        disabledSkills,
      },
      availableCategories: [],
      factories: createFactories(createSkillTool),
    })

    // then
    expect(createSkillTool).toHaveBeenCalledTimes(1)
    expect(createSkillTool.mock.calls[0]?.[0].disabledSkills).toBe(disabledSkills)
  })
})

describe("#given core skill tools are registered", () => {
  test("#when the host owns delegation #then legacy factories never run and independent tools remain executable", async () => {
    const { ctx, args } = createHostDelegationFixture()
    const managers = createManagers({ ...args, delegationOwner: "host" })
    const unavailable = (): never => { throw new Error("Legacy delegation factory invoked") }
    const factories = {
      ...createFactories(() => fakeTool),
      createBackgroundTools: unavailable,
      createCallOmoAgent: unavailable,
      createDelegateTask: unavailable,
      createGrepTools: () => ({ grep: fakeTool }),
    }

    try {
      const tools = createCoreTools({
        ctx, pluginConfig: args.pluginConfig, managers,
        skillContext: { mergedSkills: [], availableSkills: [], browserProvider: "playwright", disabledSkills: new Set() },
        availableCategories: [], factories,
      })

      expect(Object.keys(tools).sort()).toEqual(["grep", "look_at", "skill", "skill_mcp"])
      expect(await tools.grep.execute({}, { sessionID: "test", messageID: "message", agent: "worker", abort: new AbortController().signal, directory: ctx.directory, worktree: ctx.worktree, metadata: () => {}, ask: async () => {} })).toBe("ok")
    } finally {
      await managers.shutdown?.()
      await managers.skillMcpManager.disconnectAll()
    }
  })

  test("#when teams are enabled without the legacy manager #then registration rejects the unsupported capability", async () => {
    const { ctx, args } = createHostDelegationFixture()
    const managers = createManagers({ ...args, delegationOwner: "host" })

    try {
      expect(() => createTeamModeToolsRecord({
        ctx, managers,
        pluginConfig: OhMyOpenCodeConfigSchema.parse({ team_mode: { enabled: true } }),
        factories: createFactories(() => fakeTool),
      })).toThrow(UnsupportedHostDelegationError)
    } finally {
      await managers.shutdown?.()
      await managers.skillMcpManager.disconnectAll()
    }
  })

  test.each([
    { agents: false, expected: false },
    { agents: undefined, expected: true },
    { agents: true, expected: true },
  ])("#when claude_code.agents is $agents #then task receives the flag and shares the runtime skill resolver", ({ agents, expected }) => {
    const createSkillTool = mock((options: SkillLoadOptions) => fakeTool)
    const createDelegateTask = mock((options: Parameters<ToolRegistryFactories["createDelegateTask"]>[0]) => fakeTool)
    const createSkillMcpTool = mock((options: Parameters<ToolRegistryFactories["createSkillMcpTool"]>[0]) => fakeTool)
    const factories = {
      ...createFactories(createSkillTool),
      createDelegateTask,
      createSkillMcpTool,
    }

    createCoreTools({
      ctx: unsafeTestValue({
        directory: "/tmp/project",
        client: {
          config: { get: async () => ({ data: {} }) },
        },
      }),
      pluginConfig: unsafeTestValue({
        disabled_agents: ["multimodal-looker"],
        claude_code: { agents },
      }),
      managers: unsafeTestValue({
        backgroundManager: {},
        tmuxSessionManager: {},
        skillMcpManager: {},
        modelFallbackControllerAccessor: {},
      }),
      skillContext: {
        mergedSkills: [],
        availableSkills: [],
        browserProvider: "playwright",
        disabledSkills: new Set(),
      },
      availableCategories: [],
      factories,
    })

    const skillResolver = createSkillTool.mock.calls[0]?.[0].getLoadedSkills

    expect(typeof skillResolver).toBe("function")
    expect(createDelegateTask.mock.calls[0]?.[0].getLoadedSkills).toBe(skillResolver)
    expect(createDelegateTask.mock.calls[0]?.[0].claudeCodeAgentsEnabled).toBe(expected)
    expect(createSkillMcpTool.mock.calls[0]?.[0].getLoadedSkills).toBe(skillResolver)
  })

  test("#when a cleanup delay is configured #then delegate task receives it", () => {
    const createDelegateTask = mock((options: Parameters<ToolRegistryFactories["createDelegateTask"]>[0]) => fakeTool)
    const factories = {
      ...createFactories(() => fakeTool),
      createDelegateTask,
    }

    createCoreTools({
      ctx: unsafeTestValue({ directory: "/tmp/project", client: {} }),
      pluginConfig: unsafeTestValue({
        disabled_agents: ["multimodal-looker"],
        background_task: { taskCleanupDelayMs: 120000 },
      }),
      managers: unsafeTestValue({
        backgroundManager: {},
        tmuxSessionManager: {},
        skillMcpManager: {},
        modelFallbackControllerAccessor: {},
      }),
      skillContext: {
        mergedSkills: [],
        availableSkills: [],
        browserProvider: "playwright",
        disabledSkills: new Set(),
      },
      availableCategories: [],
      factories,
    })

    expect(createDelegateTask.mock.calls[0]?.[0].taskCleanupDelayMs).toBe(120000)
  })
})
