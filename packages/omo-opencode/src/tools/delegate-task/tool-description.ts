import type { AvailableCategory, AvailableSkill } from "../../agents/dynamic-agent-prompt-builder"
import { mergeCategories } from "../../shared/merge-categories"
import { hasProviderModelPins } from "../../shared/provider-model-pin"
import { CATEGORY_CALLER_GUIDANCE } from "./builtin-categories"
import { CATEGORY_DESCRIPTIONS } from "./constants"
import type { DelegateTaskToolOptions } from "./types"

export interface DelegateTaskPresentation {
  availableCategories: AvailableCategory[]
  availableSkills: AvailableSkill[]
  categoryExamples: string
  description: string
}

type DelegateTaskPresentationOptions = Pick<
  DelegateTaskToolOptions,
  "availableCategories" | "availableSkills" | "userCategories" | "providerModels"
>

export function createDelegateTaskPresentation(options: DelegateTaskPresentationOptions): DelegateTaskPresentation {
  const { userCategories } = options
  const allCategories = mergeCategories(userCategories)
  const categoryEntries = Object.entries(allCategories).map(([name, categoryConfig]) => ({
    name,
    categoryConfig,
    description: userCategories?.[name]?.description || CATEGORY_DESCRIPTIONS[name],
    callerGuidance: CATEGORY_CALLER_GUIDANCE[name],
  }))
  const categoryNames = categoryEntries.map(({ name }) => name)
  const categoryExamples = categoryNames.join(", ")

  const availableCategories: AvailableCategory[] =
    options.availableCategories ??
    categoryEntries.map(({ name, categoryConfig, description }) => {
      return {
        name,
        description: description || "General tasks",
        model: categoryConfig.model,
      }
    })

  const availableSkills: AvailableSkill[] = options.availableSkills ?? []

  const categoryList = categoryEntries
    .map(({ name, description, callerGuidance }) => {
      const categoryLine = description ? `  - ${name}: ${description}` : `  - ${name}`
      const indentedGuidance = callerGuidance?.replaceAll("\n", "\n    ")
      return indentedGuidance ? `${categoryLine}\n    ${indentedGuidance}` : categoryLine
    })
    .join("\n")

  const providerLine = hasProviderModelPins(options.providerModels)
    ? `\n  - provider: "openai" or "anthropic". Runs the child on that provider's configured model for the category or subagent_type instead of default routing, with no fallback to another provider; the call fails if no model is configured for it. Omit for default routing.`
    : ""

  const description = `Spawn agent task with category-based or direct agent selection.

  ⚠️  CRITICAL: You MUST provide EITHER category OR subagent_type. Omitting BOTH will FAIL.

  **COMMON MISTAKE (DO NOT DO THIS):**
  \`\`\`
  task(description="...", prompt="...")  // ❌ FAILS - missing category AND subagent_type
  \`\`\`

  **CORRECT - Using category:**
  \`\`\`
  task(category="quick", description="Fix type error", prompt="...")
  \`\`\`

  **CORRECT - Using subagent_type with parallel exploration:**
  \`\`\`
  task(subagent_type="explore", description="Find patterns", prompt="...", run_in_background=true)
  \`\`\`

  REQUIRED: Provide ONE of:
  - category: For task delegation (uses Sisyphus-Junior with category-optimized model)
  - subagent_type: For direct agent invocation (explore, librarian, oracle, etc.)

  **DO NOT provide both.** If category is provided, subagent_type is ignored.

  - load_skills: Optional. Defaults to [] when omitted. Pass ["skill-1", "skill-2"] for skill-specific tasks.
  - category: Use predefined category → Spawns Sisyphus-Junior with category config
    Available categories:
  ${categoryList}
  - subagent_type: Use specific agent directly (explore, librarian, oracle, metis, momus)
  - run_in_background: Default true: returns a background task ID like \`bg_...\` without waiting for the result. false blocks this response until the child finishes; use it only for a short child whose result gates your very next call.
  - wake: Each background run reports its outcome. By default, an ordinary notice wakes you only when no other child of yours is found running (see fan-out below). "each" requests a wake per run; notices close together can share a turn. "none" saves ordinary notices for your next turn without waking you, even for the last child. Errors, unrequested cancellations, and interruptions still wake you. If you cancel a task with \`background_cancel\`, the tool returns a receipt instead of sending a separate completion notice.
  - items + split: Fan-out. items is a list of work items; split (default: one per item) is how many background children share them, each getting prompt plus its contiguous slice (split=2 over A..J gives A-E and F-J). All children use the same category/subagent_type/load_skills. Unless wake is passed, the call reports once, with every child's result, when the last child finishes. Several unrelated tasks are still several task calls in one message.
  - task_id: Continuation session id (\`ses_...\`) from task metadata. Continues the same subagent session with FULL CONTEXT PRESERVED; not the background task id (\`bg_...\`).${providerLine}

  **WHEN TO USE task_id:**
  - Task failed/incomplete → \`task(task_id="ses_...", prompt="fix: [specific issue]")\`
  - Need follow-up on previous result → \`task(task_id="ses_...", prompt="Also: [question]")\`
  - Multi-turn conversation with same agent → always \`task(task_id="ses_...")\` instead of new task

  Prompts MUST be in English.`

  return {
    availableCategories,
    availableSkills,
    categoryExamples,
    description,
  }
}
