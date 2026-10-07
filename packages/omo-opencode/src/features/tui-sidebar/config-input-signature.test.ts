import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { configInputSignature, memoizeByConfigInputs } from "./config-input-signature"

const tempDirs: string[] = []

function makeLayout(): { readonly home: string; readonly project: string; readonly env: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "omo-tui-config-signature-"))
  tempDirs.push(root)
  const home = join(root, "home")
  const project = join(home, "work", "project")
  mkdirSync(project, { recursive: true })
  return { home, project, env: { HOME: home } }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("configInputSignature", () => {
  it("#given unchanged config files #when signed twice #then the signature is stable", () => {
    // given
    const { home, project, env } = makeLayout()
    mkdirSync(join(home, ".omo"))
    writeFileSync(join(home, ".omo", "omo.jsonc"), "{}")

    // when
    const first = configInputSignature(project, env)
    const second = configInputSignature(project, env)

    // then
    expect(second).toBe(first)
  })

  it("#given a user config edit #when signed again #then the signature changes", () => {
    // given
    const { home, project, env } = makeLayout()
    mkdirSync(join(home, ".omo"))
    const userConfig = join(home, ".omo", "omo.jsonc")
    writeFileSync(userConfig, "{}")
    const before = configInputSignature(project, env)

    // when
    writeFileSync(userConfig, '{ "agents": {} }')

    // then
    expect(configInputSignature(project, env)).not.toBe(before)
  })

  it("#given a project config created in an ancestor directory #when signed again #then the signature changes", () => {
    // given
    const { home, project, env } = makeLayout()
    const before = configInputSignature(project, env)

    // when
    mkdirSync(join(home, "work", ".omo"))
    writeFileSync(join(home, "work", ".omo", "omo.json"), "{}")

    // then
    expect(configInputSignature(project, env)).not.toBe(before)
  })

  it("#given a symlinked user config #when its target is edited #then the signature changes", () => {
    // given
    const { home, project, env } = makeLayout()
    const target = join(home, "dotfiles-omo.jsonc")
    writeFileSync(target, "{}")
    mkdirSync(join(home, ".omo"))
    symlinkSync(target, join(home, ".omo", "omo.jsonc"))
    const before = configInputSignature(project, env)

    // when
    writeFileSync(target, '{ "categories": {} }')
    utimesSync(target, new Date(), new Date(Date.now() + 5_000))

    // then
    expect(configInputSignature(project, env)).not.toBe(before)
  })

  it("#given a different profile env #when signed #then the signature changes", () => {
    // given
    const { project, env } = makeLayout()

    // when
    const plain = configInputSignature(project, env)
    const profiled = configInputSignature(project, { ...env, OMO_PROFILE: "work" })

    // then
    expect(profiled).not.toBe(plain)
  })
})

describe("memoizeByConfigInputs", () => {
  it("#given an unchanged signature #when called repeatedly #then it computes once", () => {
    // given
    let computeCount = 0
    const read = memoizeByConfigInputs((directory) => {
      computeCount += 1
      return { directory }
    }, () => "same")

    // when
    const first = read("/project")
    const second = read("/project")

    // then
    expect(second).toBe(first)
    expect(computeCount).toBe(1)
  })

  it("#given a changed signature or directory #when called #then it recomputes", () => {
    // given
    let signature = "a"
    let computeCount = 0
    const read = memoizeByConfigInputs(() => {
      computeCount += 1
      return computeCount
    }, () => signature)
    read("/project")

    // when
    signature = "b"
    const afterEdit = read("/project")
    const otherDirectory = read("/other")

    // then
    expect(afterEdit).toBe(2)
    expect(otherDirectory).toBe(3)
  })

  it("#given compute throws #when called again #then it retries instead of caching the failure", () => {
    // given
    let shouldThrow = true
    const read = memoizeByConfigInputs(() => {
      if (shouldThrow) throw new Error("config unreadable")
      return "ok"
    }, () => "same")
    expect(() => read("/project")).toThrow("config unreadable")

    // when
    shouldThrow = false

    // then
    expect(read("/project")).toBe("ok")
  })
})
