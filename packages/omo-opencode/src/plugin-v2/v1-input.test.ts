import { describe, expect, test } from "bun:test"
import { createV1ClientAdapter } from "./v1-client"
import { createClientFixture } from "./v1-client-fixture.test"
import { projectV1Input } from "./v1-input"

describe("v1 input projection", () => {
  test("uses the native project root and worktree directory without fabricating host fields", () => {
    const { ctx } = createClientFixture()
    const client = createV1ClientAdapter(ctx)

    const input = projectV1Input(ctx, client)

    expect(input.directory).toBe("/scratch/project/worktree")
    expect(input.worktree).toBe("/scratch/project")
    expect(String(input.project.id)).toBe("project-1")
    expect(input.serverUrl).toBeUndefined()
    expect(Object.keys(input.project)).not.toContain("time")
    expect(input.$).toBe(Bun.$)
  })

  test("throws when legacy factory code attempts workspace registration", () => {
    const { ctx } = createClientFixture()
    const input = projectV1Input(ctx, createV1ClientAdapter(ctx))

    expect(() => input.experimental_workspace.register()).toThrow("experimental_workspace.register")
  })
})
