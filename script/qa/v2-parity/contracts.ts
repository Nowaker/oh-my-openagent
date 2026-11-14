import type { ProviderHandler } from "./provider"

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }
export type JsonObject = Readonly<Record<string, JsonValue>>
export type ProbeContext = { readonly binary: string; readonly root: string; readonly version: string; readonly signal: AbortSignal }
export type Finding = { readonly status: "pass" | "skip"; readonly detail: string }
export type ProbeResult = { readonly id: string; readonly label: string; readonly status: "pass" | "fail" | "skip"; readonly detail: string; readonly durationMs: number }
export type Probe = { readonly id: string; readonly label: string; readonly run: (context: ProbeContext) => Promise<Finding> }
export type Report = { readonly binary: string; readonly version: string; readonly root: string; readonly results: readonly ProbeResult[]; readonly ok: boolean }
export type Sandbox = {
  readonly scratchRoot?: string
  readonly nativeRunRoot?: string
  readonly root: string; readonly home: string; readonly project: string; readonly database: string; readonly config: string;
  readonly env: Record<string, string> & { readonly TMPDIR: string }
}
export type Engine = AsyncDisposable & {
  readonly sandbox: Sandbox; readonly url: string; readonly password: string; readonly authorization: string;
  readonly process: { readonly pid: number; readonly exitCode: number | null; kill(signal?: number | NodeJS.Signals): void }
  readonly stop: () => Promise<void>
}
export type NativeEvent = { readonly type: string; readonly data: JsonValue; readonly location?: { readonly directory: string } }
export type EventSubscription = AsyncDisposable & { readonly result: Promise<NativeEvent> }
export type RequestInput = { readonly method?: string; readonly body?: unknown }
export type HttpResult = { readonly status: number; readonly body: unknown }
export type Harness = {
  readonly createSandbox: (context: Pick<ProbeContext, "root">, name: string) => Sandbox
  readonly assertInside: (root: string, path: string) => void
  readonly startEngine: (context: ProbeContext, sandbox: Sandbox) => Promise<Engine>
  readonly request: (engine: Engine, path: string, input?: RequestInput) => Promise<HttpResult>
  readonly execute: (context: Pick<ProbeContext, "binary" | "signal">, sandbox: Sandbox, input: { readonly args: readonly string[] }) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>
  readonly within: <T>(work: Promise<T>, milliseconds: number, label: string) => Promise<T>
  readonly subscribeEvent: (context: ProbeContext, engine: Engine, predicate: (event: NativeEvent) => boolean) => Promise<EventSubscription>
  readonly runChecks: (context: ProbeContext, probes: readonly Probe[], afterCheck?: () => void) => Promise<readonly ProbeResult[]>
  readonly createRunRoot: (parent: string) => string
  readonly settleRunArtifacts: (root: string) => void
  readonly completeRun: (root: string) => void
  readonly renderProbeReport: (report: Report, format: "text" | "json") => string
}
export type ParityContext = ProbeContext & {
  readonly toolsDirectory: string; readonly pluginBundle: string; readonly sourceDirectory: string; readonly harness: Harness
}
export type ParityProbe = { readonly id: string; readonly label: string; readonly run: (context: ParityContext) => Promise<Finding> }
export type ScenarioOptions = {
  readonly id: string; readonly handler: ProviderHandler; readonly omo?: JsonObject; readonly opencode?: JsonObject;
  readonly prepare?: (sandbox: Sandbox) => void | Promise<void>
}
