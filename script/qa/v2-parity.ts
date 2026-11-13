import { parseParityArgs } from "./v2-parity/args"
import { loadHarness } from "./v2-parity/harness"
import { parityPlan } from "./v2-parity/plan"
import { renderParityReport } from "./v2-parity/report"
import { runParitySuite } from "./v2-parity/suite"

const usage = `usage: bun script/qa/v2-parity.ts --binary PATH --tools-directory PATH --plugin-bundle PATH [--baseline-bundle PATH] [--evidence-dir PATH] [--format text|json]

Run OMO's v2 bridge parity suite against one opencode2 executable and one built OMO bundle.
Every scenario runs in an isolated scratch HOME, database and config with a local scripted
provider; nothing reads or writes live opencode state.

flags:
  --binary PATH           opencode2 executable to test
  --tools-directory PATH  opencode-tools checkout providing _lib/opencode-v2-probe
  --plugin-bundle PATH    built OMO server bundle (dist/index.js, with dist/skills beside it)
  --baseline-bundle PATH  old bundle the native-glob detector must reject; omitted, that row is skipped
  --evidence-dir PATH     where run directories are created (default .omo/evidence/v2-parity)
  --format text|json      report format (default text)
  -h, --help              show this help

Exit codes: 0 = no failed check or row; 1 = a check, row or the run failed; 2 = usage error.
`

const command = parseParityArgs(Bun.argv.slice(2))
switch (command.kind) {
  case "help":
    process.stdout.write(usage)
    break
  case "usage-error":
    process.stderr.write(`error: ${command.detail}\n       run with --help for full usage\n`)
    process.exitCode = 2
    break
  case "run": {
    const controller = new AbortController()
    const abort = () => controller.abort()
    process.once("SIGINT", abort)
    process.once("SIGTERM", abort)
    try {
      const report = await runParitySuite({ ...command.input, signal: controller.signal }, parityPlan(command.input.baselineBundle))
      process.stdout.write(renderParityReport(report, command.format, await loadHarness(command.input.toolsDirectory)))
      process.exitCode = report.ok ? 0 : 1
    } finally {
      process.removeListener("SIGINT", abort)
      process.removeListener("SIGTERM", abort)
    }
    break
  }
  default:
    throw new TypeError(`Unexpected parity command: ${command satisfies never}`)
}
