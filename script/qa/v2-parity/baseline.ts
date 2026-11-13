import assert, { AssertionError } from "node:assert/strict"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { bridgeRegressionProbes } from "./bridge-regressions"
import type { ParityProbe } from "./contracts"

const id = "baseline-native-glob-rejection"
const label = "Same detector rejects the old native-glob false positive"

export function baselineProbe(bundle: string | undefined): ParityProbe {
  if (bundle === undefined) return { id, label,
    run: async () => ({ status: "skip", detail: "No --baseline-bundle supplied; the native-glob detector's discrimination against the old bundle was not re-proved in this run" }) }
  return { id, label,
    async run(context) {
      const detector = bridgeRegressionProbes.find((probe) => probe.id === "bridge-native-glob-origin")
      assert.ok(detector, "Native-glob detector is missing")
      const root = join(context.root, "baseline-control")
      mkdirSync(root)
      let failure: Error | undefined
      try { await detector.run({ ...context, root, pluginBundle: bundle }) }
      catch (error) { if (!(error instanceof Error)) throw error; failure = error }
      assert.ok(failure instanceof AssertionError, "Old bundle must fail the same detector with an assertion")
      const receipt = z.object({ bundleSha256: z.string(), terminal: z.literal("session.execution.succeeded"),
        nativeGlobWouldLookSuccessful: z.literal(true), omoOnlyAdmitted: z.literal(false), omoOnlyCompleted: z.literal(false),
      }).parse(JSON.parse(readFileSync(join(root, detector.id, "bridge-receipt.json"), "utf8")))
      assert.match(failure.message, /^OMO-only background_output was not admitted/, "Negative control failed for an unrelated reason")
      writeFileSync(join(root, "negative-control.json"), JSON.stringify({ receipt, expectedFailure: failure.message }, null, 2) + "\n")
      return { status: "pass", detail: `Old bundle ${receipt.bundleSha256} completed native glob but lacked OMO-only admission; identical detector rejected it` }
    } }
}
