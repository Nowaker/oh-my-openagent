import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { retainNativeScratch } from "./sandbox-storage"

test("retains closed native data without copying regenerable caches or changing the source", () => {
  // given
  const evidence = join(process.cwd(), ".omo/evidence")
  mkdirSync(evidence, { recursive: true })
  const artifacts = mkdtempSync(join(evidence, "sandbox-owner-"))
  const scratchRoot = mkdtempSync(join(tmpdir(), "omo-sandbox-owner-"))
  const marker = `owned-native-data-${crypto.randomUUID()}`
  writeFileSync(join(scratchRoot, "opencode-v2.db"), marker)
  mkdirSync(join(scratchRoot, "bun-cache"))
  writeFileSync(join(scratchRoot, "bun-cache/regenerable"), "cache")
  mkdirSync(join(scratchRoot, "tmp"))
  writeFileSync(join(scratchRoot, "tmp/.bun-fixture.so"), "regenerable native library")
  writeFileSync(join(scratchRoot, "tmp/oh-my-opencode.log"), marker)

  try {
    // when
    retainNativeScratch({ root: artifacts, scratchRoot })

    // then
    expect(readFileSync(join(artifacts, "native-scratch/opencode-v2.db"), "utf8")).toBe(marker)
    expect(existsSync(join(artifacts, "native-scratch/bun-cache"))).toBe(false)
    expect(existsSync(join(artifacts, "native-scratch/tmp/.bun-fixture.so"))).toBe(false)
    expect(readFileSync(join(artifacts, "native-scratch/tmp/oh-my-opencode.log"), "utf8")).toBe(marker)
    expect(readFileSync(join(scratchRoot, "opencode-v2.db"), "utf8")).toBe(marker)
  } finally { rmSync(scratchRoot, { recursive: true, force: true }) }
})
