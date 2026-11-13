import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { parseParityArgs } from "./args"

describe("parity CLI arguments", () => {
  const required = ["--binary", "./engine", "--tools-directory", "./tools", "--plugin-bundle", "./candidate.js", "--baseline-bundle", "./old.js"]

  test("resolves all explicit paths and the default evidence directory", () => {
    // given / when
    const command = parseParityArgs(required)
    // then
    expect(command).toEqual({ kind: "run", format: "text", input: {
      binary: resolve("engine"), toolsDirectory: resolve("tools"), pluginBundle: resolve("candidate.js"),
      baselineBundle: resolve("old.js"), evidenceDirectory: resolve(".omo/evidence/v2-parity"),
    } })
  })

  test("omits the baseline control when no baseline bundle is named", () => {
    // given
    const withoutBaseline = required.slice(0, -2)
    // when
    const command = parseParityArgs(withoutBaseline)
    // then
    expect(command.kind).toBe("run")
    if (command.kind !== "run") throw new Error("Expected a runnable command")
    expect("baselineBundle" in command.input).toBe(false)
  })

  test("accepts an explicit JSON report and evidence directory", () => {
    // given / when
    const command = parseParityArgs([...required, "--format", "json", "--evidence-dir", "./proof"])
    // then
    expect(command.kind).toBe("run")
    if (command.kind !== "run") throw new Error("Expected a runnable command")
    expect(command.format).toBe("json")
    expect(command.input.evidenceDirectory).toBe(resolve("proof"))
  })

  test.each(["--binary", "--tools-directory", "--plugin-bundle"])("requires %s instead of using a live default", (flag) => {
    // given
    const args = required.filter((_, index) => required[index] !== flag && required[index - 1] !== flag)
    // when
    const command = parseParityArgs(args)
    // then
    expect(command).toEqual({ kind: "usage-error", detail: `missing required argument: ${flag} PATH` })
  })

  const invalid: readonly (readonly string[])[] = [
    ["--format", "markdown"], ["--evidence-dir", " "], ["--binary", ""], ["--baseline-bundle", " "], ["unexpected"], ["--unknown"],
  ]
  test.each(invalid.map((args) => ({ args })))("rejects invalid arguments %j", ({ args }) => {
    // given / when
    const command = parseParityArgs([...required, ...args])
    // then
    expect(command.kind).toBe("usage-error")
  })

  test("allows help without resolving or starting an executable", () => {
    // given / when
    const command = parseParityArgs(["--help"])
    // then
    expect(command).toEqual({ kind: "help" })
  })
})
