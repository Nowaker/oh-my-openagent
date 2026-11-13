import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { accessSync, constants, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { z } from "zod"
import type { SuitePaths } from "./args"
import type { ParityContext, ParityProbe, Report } from "./contracts"
import { loadHarness } from "./harness"
import { evaluateMatrix, paritySucceeded, type MatrixResult, type MatrixRow } from "./matrix"

export type ParityPlan = { readonly probes: readonly ParityProbe[]; readonly rows: readonly MatrixRow[] }
export type ParityReport = Report & {
  readonly matrix: readonly MatrixResult[]
  readonly provenance: { readonly binarySha256: string; readonly bundleSha256: string; readonly baselineSha256: string | null }
}
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex")

export async function runParitySuite(input: SuitePaths & { readonly signal: AbortSignal }, plan: ParityPlan): Promise<ParityReport> {
  const binary = realpathSync(input.binary)
  const pluginBundle = realpathSync(input.pluginBundle)
  const baselineBundle = input.baselineBundle === undefined ? null : realpathSync(input.baselineBundle)
  for (const file of [binary, pluginBundle, baselineBundle]) if (file !== null) assert.ok(statSync(file).isFile(), `Expected a regular file: ${file}`)
  accessSync(binary, constants.X_OK)
  const provenance = { binarySha256: sha256(binary), bundleSha256: sha256(pluginBundle), baselineSha256: baselineBundle === null ? null : sha256(baselineBundle) }
  assert.notEqual(provenance.bundleSha256, provenance.baselineSha256, "Candidate and old baseline must be distinct artifacts")
  assert.equal(new Set(plan.probes.map((probe) => probe.id)).size, plan.probes.length, "Duplicate parity probe identifiers")
  const toolsDirectory = realpathSync(input.toolsDirectory)
  const harness = await loadHarness(toolsDirectory)
  mkdirSync(input.evidenceDirectory, { recursive: true })
  const root = harness.createRunRoot(input.evidenceDirectory)
  let failure: Error | undefined
  try {
    const bootstrap = { binary, root, signal: input.signal }
    const inspected = await harness.execute(bootstrap, harness.createSandbox(bootstrap, "version"), { args: ["--version"] })
    assert.equal(inspected.code, 0, `Native --version failed; artifacts: ${root}`)
    const version = z.string().regex(/^(?:opencode\s+)?v?2\./).parse(inspected.stdout.trim())
    const context: ParityContext = { ...bootstrap, version, toolsDirectory, pluginBundle,
      sourceDirectory: resolve(import.meta.dir, "../../.."), harness }
    const probes = plan.probes.map((probe) => ({ id: probe.id, label: probe.label, run: () => probe.run(context) }))
    const results = await harness.runChecks(context, probes, () => harness.settleRunArtifacts(root))
    input.signal.throwIfAborted()
    const matrix = evaluateMatrix(plan.rows, results)
    const report: ParityReport = { binary, version, root, results, matrix, provenance, ok: paritySucceeded(results, matrix) }
    assert.equal(sha256(binary), provenance.binarySha256, "Native binary changed during parity execution")
    assert.equal(sha256(pluginBundle), provenance.bundleSha256, "Candidate bundle changed during parity execution")
    if (baselineBundle !== null) assert.equal(sha256(baselineBundle), provenance.baselineSha256, "Preserved baseline changed during parity execution")
    writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2) + "\n")
    return report
  } catch (error) {
    failure = error instanceof Error ? error : new AggregateError([error], "Non-Error parity failure")
    throw failure
  } finally {
    const errors: Error[] = []
    for (const finalize of [() => harness.settleRunArtifacts(root), () => harness.completeRun(root)]) {
      try { finalize() }
      catch (error) { errors.push(error instanceof Error ? error : new AggregateError([error], "Non-Error finalization failure")) }
    }
    if (errors.length > 0) throw new AggregateError(failure === undefined ? errors : [failure, ...errors], "Parity artifact finalization failed")
  }
}
