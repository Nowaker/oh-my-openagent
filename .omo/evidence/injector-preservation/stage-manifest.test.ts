import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"

test("stages the alias without changing dependency versions", () => {
  const root = mkdtempSync(join(tmpdir(), "omo-alias-stage-"))
  const file = join(root, "package.json")
  const fixture = { name: "oh-my-opencode", version: "4.19.4", optionalDependencies: { "oh-my-opencode-linux-x64": "4.19.4" }, dependencies: { zod: "^4.4.3" } }
  try {
    writeFileSync(file, JSON.stringify(fixture))
    const result = Bun.spawnSync(["bun", join(import.meta.dir, "stage-manifest.ts"), file, "4.19.4-nowaker.1"])
    expect(result.exitCode).toBe(0)
    const output = z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(file, "utf8")))
    expect(output).toEqual({ ...fixture, name: "oh-my-openagent", version: "4.19.4-nowaker.1", optionalDependencies: { "oh-my-openagent-linux-x64": "4.19.4" } })
  } finally { rmSync(root, { recursive: true, force: true }) }
})
