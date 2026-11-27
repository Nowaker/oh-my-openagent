import { createHash, randomUUID } from "node:crypto"
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import { createLockRecord, LockContentionError, withLock } from "@oh-my-opencode/memory-core"
import { z } from "zod"
import { getDataDir } from "../../shared/data-path"
import { tolerantFsyncSync } from "../../shared/tolerant-fsync"
import { OwnerProcessSchema, TaskOwnerSchema } from "../background-agent/task-recovery-store"

const ParentSessionIdSchema = z.string().min(1)
const RunIdSchema = z.string().uuid().length(36)
const TaskRunRecordSchema = z
  .strictObject({
    version: z.literal(1),
    runId: RunIdSchema,
    parentSessionId: ParentSessionIdSchema,
    taskId: z.string().min(1),
    childSessionId: z.string().min(1).optional(),
    directory: z.string().min(1),
    childDirectory: z.string().min(1).optional(),
    description: z.string(),
    agent: z.string().min(1),
    prompt: z.string().optional(),
    startedAt: z.number().int().nonnegative(),
    wake: z.enum(["each", "none"]).optional(),
    owner: TaskOwnerSchema,
    ownerProcess: OwnerProcessSchema.optional(),
    terminal: z.strictObject({ notification: z.string(), shouldReply: z.boolean() }).readonly().optional(),
  })
  .refine((record) => record.childSessionId === undefined || record.prompt === undefined, {
    path: ["prompt"],
    message: "A run with a child session must not persist its prompt",
  })

export type TaskRunRecord = Readonly<z.infer<typeof TaskRunRecordSchema>>

class TaskRunStoreError extends Error {
  override readonly name = "TaskRunStoreError"

  constructor(
    readonly path: string,
    readonly reason:
      | "not a private directory"
      | "not a regular file"
      | "invalid JSON"
      | "invalid v1 record"
      | "identity mismatch",
  ) {
    super(`Invalid task run storage at ${path}: ${reason}`)
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

function assertPrivateDirectory(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
    throw new TaskRunStoreError(path, "not a private directory")
  }
}

function syncDirectory(path: string): void {
  if (process.platform === "win32") return
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY)
  try {
    tolerantFsyncSync(descriptor, `TaskRunStore:${path}`)
  } finally {
    closeSync(descriptor)
  }
}

function readRun(file: string, parentSessionId: string, filenameId: string): TaskRunRecord | undefined {
  let raw: string
  try {
    if (process.platform === "win32" && !lstatSync(file).isFile()) {
      throw new TaskRunStoreError(file, "not a regular file")
    }
    const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      if (!fstatSync(descriptor).isFile()) throw new TaskRunStoreError(file, "not a regular file")
      raw = readFileSync(descriptor, "utf8")
    } finally {
      closeSync(descriptor)
    }
  } catch (error) {
    if (isMissing(error)) return undefined
    if (error instanceof Error && "code" in error && error.code === "ELOOP") {
      throw new TaskRunStoreError(file, "not a regular file")
    }
    throw error
  }

  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    if (error instanceof SyntaxError) throw new TaskRunStoreError(file, "invalid JSON")
    throw error
  }
  const parsed = TaskRunRecordSchema.safeParse(value)
  if (!parsed.success) throw new TaskRunStoreError(file, "invalid v1 record")
  if (parsed.data.parentSessionId !== parentSessionId || parsed.data.runId.toLowerCase() !== filenameId) {
    throw new TaskRunStoreError(file, "identity mismatch")
  }
  return parsed.data
}

/** Atomic persistence only. Callers must fence competing updates and delivery for the same run. */
export class TaskRunStore {
  private readonly root: string

  constructor(root = join(getDataDir(), "omo", "running-jobs", "runs")) {
    this.root = resolve(root)
  }

  list(parentSessionId: string): TaskRunRecord[] {
    const directory = this.parentDirectory(parentSessionId)
    let names: string[]
    try {
      this.assertParentDirectory(directory)
      names = readdirSync(directory)
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }

    const records: TaskRunRecord[] = []
    for (const name of names) {
      if (!name.endsWith(".json")) continue
      const filenameId = name.slice(0, -5)
      if (filenameId !== filenameId.toLowerCase() || !RunIdSchema.safeParse(filenameId).success) continue
      try {
        const record = readRun(join(directory, name), parentSessionId, filenameId)
        if (record !== undefined) records.push(record)
      } catch (error) {
        // One invalid record must not hide other runs or be treated as safe to replace.
        if (!(error instanceof TaskRunStoreError)) throw error
      }
    }
    return records
  }

  write(record: TaskRunRecord): void {
    const next = TaskRunRecordSchema.parse(record)
    const directory = this.parentDirectory(next.parentSessionId)
    const filenameId = next.runId.toLowerCase()
    const file = join(directory, `${filenameId}.json`)

    const firstCreated = mkdirSync(this.root, { recursive: true, mode: 0o700 })
    assertPrivateDirectory(this.root)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    assertPrivateDirectory(directory)
    readRun(file, next.parentSessionId, filenameId)

    const temporary = `${file}.${randomUUID()}.tmp`
    const descriptor = openSync(temporary, "wx", 0o600)
    try {
      try {
        writeFileSync(descriptor, JSON.stringify(next), "utf8")
        tolerantFsyncSync(descriptor, `TaskRunStore:${file}`)
      } finally {
        closeSync(descriptor)
      }
      renameSync(temporary, file)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
    syncDirectory(directory)
    syncDirectory(this.root)
    if (firstCreated !== undefined) {
      const existingAncestor = dirname(firstCreated)
      for (let path = dirname(this.root); ; path = dirname(path)) {
        syncDirectory(path)
        if (path === existingAncestor || path === dirname(path)) break
      }
    }
  }

  read(parentSessionId: string, runId: string): TaskRunRecord | undefined {
    const directory = this.parentDirectory(parentSessionId)
    const filenameId = RunIdSchema.parse(runId).toLowerCase()
    try {
      this.assertParentDirectory(directory)
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
    return readRun(join(directory, `${filenameId}.json`), parentSessionId, filenameId)
  }

  async claim(previous: TaskRunRecord, next: Pick<TaskRunRecord, "owner" | "ownerProcess" | "terminal">): Promise<boolean> {
    const directory = this.parentDirectory(previous.parentSessionId)
    const id = RunIdSchema.parse(previous.runId).toLowerCase()
    const lock = await createLockRecord("background-run-recovery", { runId: id })
    try {
      return await withLock(join(directory, `${id}.lock`), lock, async () => {
        const current = this.read(previous.parentSessionId, id)
        if (!current || current.owner.id !== previous.owner.id) return false
        this.write({ ...current, ...next, terminal: current.terminal ?? next.terminal })
        return true
      }, { waitTimeoutMs: 0 })
    } catch (error) {
      if (error instanceof LockContentionError) return false
      throw error
    }
  }

  remove(parentSessionId: string, runId: string): void {
    const directory = this.parentDirectory(parentSessionId)
    const filenameId = RunIdSchema.parse(runId).toLowerCase()
    const file = join(directory, `${filenameId}.json`)
    try {
      this.assertParentDirectory(directory)
      if (readRun(file, parentSessionId, filenameId) === undefined) return
      unlinkSync(file)
    } catch (error) {
      if (isMissing(error)) return
      throw error
    }
    syncDirectory(directory)
  }

  private parentDirectory(parentSessionId: string): string {
    const id = ParentSessionIdSchema.parse(parentSessionId)
    return join(this.root, createHash("sha256").update(JSON.stringify(id)).digest("hex"))
  }

  private assertParentDirectory(directory: string): void {
    assertPrivateDirectory(this.root)
    assertPrivateDirectory(directory)
  }
}
