import { expect, test } from "bun:test"
import { createNativeJobDependencies } from "./native-task-controls"
import { createNativeTaskFixture } from "./native-task-test-fixture"

test("uses the advertised native job domain and preserves its ownership and unsettled result", async () => {
  // given
  const fixture = await createNativeTaskFixture()
  const reads: unknown[] = []
  const stops: unknown[] = []
  const jobs = [{ id: "shell-job", sessionID: "ses_parent", kind: "shell" as const, status: "running" as const }]
  const deps = createNativeJobDependencies({ ...fixture.ctx,
    app: { ...fixture.ctx.app, capabilities: { jobControl: true } },
    job: { list: async (input) => { reads.push(input); return { data: jobs } }, cancel: async (input) => { stops.push(input); return { status: "requested" } } },
  })
  try {
    if (!deps.listJobs || !deps.cancelJob) throw new Error("Native job domain was not projected")
    // when
    const listed = await deps.listJobs("ses_parent", true)
    const result = await deps.cancelJob({ id: "shell-job", parentSessionID: "ses_parent", signal: fixture.context.signal })
    // then
    expect(listed).toBe(jobs)
    expect(reads).toEqual([{ parentSessionID: "ses_parent", descendants: true }])
    expect(stops).toEqual([{ parentID: "ses_parent", jobID: "shell-job" }])
    expect(result).toEqual({ status: "requested" })
  } finally { await fixture.close() }
})

test("keeps missing capabilities unsupported and refuses a falsely advertised native job domain", async () => {
  const fixture = await createNativeTaskFixture()
  try {
    expect(createNativeJobDependencies(fixture.ctx)).toEqual({})
    expect(() => createNativeJobDependencies({ ...fixture.ctx, app: { ...fixture.ctx.app, capabilities: { jobControl: true } } })).toThrow("advertised jobControl methods")
  } finally { await fixture.close() }
})

test("projects the advertised raw result read/wait with actual job ownership and signal", async () => {
  const fixture = await createNativeTaskFixture()
  const requests: unknown[] = []
  const result = { id: "shell-job", sessionID: "ses_parent", kind: "shell" as const, status: "completed" as const, output: "native captured output" }
  const native = { result: async (input: unknown, options: unknown) => { requests.push({ input, options }); return result } }
  try {
    const deps = createNativeJobDependencies({ ...fixture.ctx, app: { ...fixture.ctx.app, capabilities: { jobResults: true } }, job: native })
    if (!deps.resultJob) throw new Error("Advertised native result method was not projected")
    expect(await deps.resultJob({ id: "shell-job", parentSessionID: "ses_parent", wait: true, signal: fixture.context.signal })).toBe(result)
    expect(requests).toEqual([{ input: { parentID: "ses_parent", jobID: "shell-job", wait: true }, options: { signal: fixture.context.signal } }])
    expect(createNativeJobDependencies({ ...fixture.ctx, job: native }).resultJob).toBeUndefined()
    expect(() => createNativeJobDependencies({ ...fixture.ctx, app: { ...fixture.ctx.app, capabilities: { jobResults: true } } })).toThrow("advertised jobResults method")
  } finally { await fixture.close() }
})
