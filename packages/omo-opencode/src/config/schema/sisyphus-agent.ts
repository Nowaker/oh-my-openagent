import { z } from "zod"

export const SisyphusAgentConfigSchema = z.object({
  disabled: z.boolean().optional(),
  default_builder_enabled: z.boolean().optional(),
  planner_enabled: z.boolean().optional(),
  replace_plan: z.boolean().optional(),
  tdd: z.boolean().default(true).optional(),
  gpt_to_hephaestus: z
    .boolean()
    .optional()
    .describe(
      "Send Sisyphus on any GPT model to Hephaestus, including GPT models with a GPT-native Sisyphus prompt. Default false: only GPT models without one are sent.",
    ),
  share_prompt_with_hephaestus: z
    .boolean()
    .optional()
    .describe(
      "Give Hephaestus the same prompt Sisyphus would get on Hephaestus's model, orchestration instructions included, so the two agents differ only in name. Default false.",
    ),
})

export type SisyphusAgentConfig = z.infer<typeof SisyphusAgentConfigSchema>
