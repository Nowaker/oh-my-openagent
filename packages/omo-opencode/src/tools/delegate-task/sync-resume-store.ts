import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { getDataDir } from "../../shared/data-path"

const SyncResumeSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().min(1),
  agent: z.string().min(1),
  tools: z.record(z.string(), z.boolean()),
  model: z.object({
    providerID: z.string().min(1), modelID: z.string().min(1), variant: z.string().optional(),
    reasoning: z.string().optional(), reasoningEffort: z.string().optional(),
    temperature: z.number().optional(), top_p: z.number().optional(), maxTokens: z.number().optional(),
    thinking: z.object({ type: z.enum(["enabled", "disabled"]), budgetTokens: z.number().optional() }).strict().optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
  }).strict().optional(),
}).strict()

export type SyncResumeRecord = z.infer<typeof SyncResumeSchema>

export class SyncResumeIdentityError extends Error {
  constructor(readonly sessionId: string) {
    super(`Cannot resume sync session ${sessionId}: metadata identity mismatch`)
    this.name = "SyncResumeIdentityError"
  }
}

export class SyncResumeStore {
  private readonly root = join(getDataDir(), "omo", "sync-resume")

  private path(sessionId: string): string {
    return join(this.root, `${createHash("sha256").update(sessionId).digest("hex")}.json`)
  }

  read(sessionId: string): SyncResumeRecord | undefined {
    try {
      const record = SyncResumeSchema.parse(JSON.parse(readFileSync(this.path(sessionId), "utf8")))
      if (record.sessionId !== sessionId) throw new SyncResumeIdentityError(sessionId)
      return record
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
      throw error
    }
  }

  write(record: SyncResumeRecord): void {
    const parsed = SyncResumeSchema.parse(record)
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const path = this.path(parsed.sessionId)
    const temporary = `${path}.${randomUUID()}`
    try {
      writeFileSync(temporary, JSON.stringify(parsed), { mode: 0o600, flag: "wx" })
      renameSync(temporary, path)
    } catch (error) {
      try { unlinkSync(temporary) } catch (cleanupError) {
        if (!(cleanupError instanceof Error && "code" in cleanupError && cleanupError.code === "ENOENT")) throw cleanupError
      }
      throw error
    }
  }
}
