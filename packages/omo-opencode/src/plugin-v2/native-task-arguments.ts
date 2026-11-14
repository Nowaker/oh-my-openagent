import { z } from "zod"

export const nativeTaskArguments = z.object({
  load_skills: z.array(z.string()).optional().describe("Skill names to inject; omission means no new skill selection and preserves skills on continuation."),
  description: z.string().optional().describe("Short task description, generated from prompt when omitted."),
  prompt: z.string().describe("Detailed task or continuation instructions."),
  run_in_background: z.boolean().optional().describe("Default true. false waits through native foreground execution or configured handoff."),
  wake: z.enum(["each", "none"]).optional().describe("each reports native completion; none suppresses the notice. Omitted fan-out wake groups every slot into one native notice."),
  items: z.array(z.string().min(1)).min(1).optional().describe("Fan-out items; every child receives its contiguous share of the work."),
  split: z.number().int().min(1).optional().describe("Number of contiguous child groups; default one child per item."),
  category: z.string().optional().describe("Configured OMO category; takes precedence over subagent_type for a new selection."),
  subagent_type: z.string().optional().describe("Named OMO agent, or fork for a new own-agent/model child with settled parent history. Native capability is required for fork."),
  task_id: z.string().optional().describe("Durable native child session ID to continue under the same parent; use the sessionID receipt, not bg_ alias."),
}).strict()
export type NativeTaskArguments = z.infer<typeof nativeTaskArguments>

export const nativeCallArguments = z.object({ description: z.string(), prompt: z.string(), subagent_type: z.string(), run_in_background: z.boolean(), session_id: z.string().optional() }).strict()
export const nativeOutputArguments = z.object({
  task_id: z.string(), block: z.boolean().optional(), timeout: z.number().min(0).optional(), full_session: z.boolean().optional(), include_thinking: z.boolean().optional(),
  message_limit: z.number().int().min(1).optional(), since_message_id: z.string().optional(), include_tool_results: z.boolean().optional(),
  from_end: z.boolean().optional(), thinking_max_chars: z.number().int().min(0).optional(),
}).strict()
export type NativeOutputArguments = z.infer<typeof nativeOutputArguments>
export const nativeCancelArguments = z.object({ taskId: z.string().optional(), all: z.boolean().optional() }).strict()
export type NativeCancelArguments = z.infer<typeof nativeCancelArguments>

export const nativeSubagentResult = z.object({ sessionID: z.string(), status: z.enum(["running", "completed"]), output: z.string() })
export type NativeSubagentReceipt = z.infer<typeof nativeSubagentResult> & { readonly background_task_id: string }
export type NativeNotice = "each" | "none" | { readonly group: { readonly id: string; readonly index: number; readonly total: number } }
