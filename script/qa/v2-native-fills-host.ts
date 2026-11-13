import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createInterface } from "node:readline"
import { z } from "zod"
import { NativeEvents } from "./v2-native-fills-events"
import { createProvider } from "./v2-native-fills-provider"
import { prepareNativeFixtures } from "./v2-native-fills-fixtures"
import { configureSandbox, createSandbox, evidenceWriter, fingerprint } from "./v2-native-fills-sandbox"
import { NativeFillFailure, requireProof } from "./v2-native-fills-contract"
import type { DriverOptions, ScenarioHost } from "./v2-native-fills-contract"

export async function withNativeHost<T>(options: DriverOptions, scenario: (host: ScenarioHost) => Promise<T>): Promise<T> {
  const sandbox = createSandbox(options)
  const fixtures = prepareNativeFixtures(sandbox.project, options.scenario)
  const password = randomBytes(24).toString("base64url")
  const encoded = Buffer.from(`opencode:${password}`).toString("base64")
  const authorization = `Basic ${encoded}`
  const { save, sanitize } = evidenceWriter(sandbox.root, [password, encoded, authorization])
  const provider = await createProvider(save)
  const abort = new AbortController()
  const deadline = setTimeout(() => abort.abort(), 180000)
  const onSignal = () => abort.abort()
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)
  const events = new NativeEvents(abort.signal, save)
  let processCapture = ""
  let eventCapture: Promise<void> | undefined
  let child: ReturnType<typeof spawn> | undefined
  let exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined
  let settled = false
  let forced = false
  let result: T | undefined
  let failure: unknown
  try {
    configureSandbox(sandbox, Number(provider.url.port), options.scenario === "overflow")
    save("isolation.json", { ...sandbox, liveDatabaseAccess: false, configWalk: "project -> scratch HOME", binarySha256: await fingerprint(sandbox.binary), pluginSha256: await fingerprint(sandbox.plugin) })
    child = spawn(sandbox.binary, ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0", "--print-logs", "--log-level", "debug"], {
      cwd: sandbox.project, env: { ...sandbox.env, OPENCODE_PASSWORD: password }, detached: true, stdio: ["pipe", "pipe", "pipe"],
    })
    const owned = child
    let stderr = ""
    if (owned.stderr) createInterface({ input: owned.stderr, crlfDelay: Infinity }).on("line", (line) => {
      stderr += `${sanitize(line)}\n`
      save("server-stderr.log", stderr)
    })
    exit = new Promise((resolve, reject) => {
      owned.once("error", reject)
      owned.once("close", (code, signal) => { settled = true; resolve({ code, signal }) })
    })
    void exit.catch(() => abort.abort())
    const endpoint = await new Promise<string>((resolve, reject) => {
      const aborted = () => reject(new NativeFillFailure("Server readiness aborted"))
      abort.signal.addEventListener("abort", aborted, { once: true })
      if (owned.stdout) createInterface({ input: owned.stdout, crlfDelay: Infinity }).on("line", (line) => {
        processCapture += `${sanitize(line)}\n`
        save("server-stdout.log", processCapture)
        if (!line.startsWith("{")) return
        try {
          const parsed = z.object({ url: z.string().optional() }).parse(JSON.parse(line))
          if (parsed.url) {
            const url = new URL(parsed.url)
            requireProof(url.hostname === "127.0.0.1", "Owned server must listen on loopback")
            abort.signal.removeEventListener("abort", aborted)
            resolve(url.href)
          }
        } catch (error) {
          if (!(error instanceof Error)) throw error
          reject(error)
        }
      })
      void exit?.then(() => reject(new NativeFillFailure("Server exited before readiness")), reject)
    })
    const target = (path: string) => {
      const url = new URL(path, endpoint)
      url.searchParams.set("location[directory]", sandbox.project)
      return url
    }
    const api = async (path: string, body?: unknown): Promise<unknown> => {
      const response = await fetch(target(path), {
        method: body === undefined ? "GET" : "POST", headers: { authorization, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(90000)]),
      })
      requireProof(response.ok, `Native API ${path}: HTTP ${response.status}`)
      return response.status === 204 ? null : response.json()
    }
    const eventResponse = await fetch(target("/api/event"), { headers: { authorization }, signal: abort.signal })
    eventCapture = events.consume(eventResponse)
    await events.wait((event) => event.type === "server.connected")
    let cursor = 0
    await api("/api/agent")
    for (;;) {
      const update = await events.wait((event) => event.type === "plugin.updated", cursor)
      cursor = events.rows.indexOf(update) + 1
      const inventory = z.object({ data: z.array(z.object({ id: z.string().optional(), state: z.object({ status: z.string() }).passthrough() }).passthrough()) }).parse(await api("/api/plugin"))
      save("plugins.json", inventory)
      const candidate = inventory.data.find((entry) => entry.id === "oh-my-openagent")
      if (candidate?.state.status === "active") break
      requireProof(candidate?.state.status !== "failed" && candidate?.state.status !== "error", "Real OMO plugin activation failed")
    }
    save("fixtures.json", fixtures)
    result = await scenario({ root: sandbox.root, project: sandbox.project, fixtures, requests: provider.requests, events: events.rows, signal: abort.signal, api, save, script: provider.script, waitEvent: events.wait })
    requireProof(provider.failures.length === 0, "Provider script failed; inspect provider-failures.json")
  } catch (error) {
    failure = error instanceof Error ? error : new NativeFillFailure("Scenario raised a non-Error value")
  } finally {
    clearTimeout(deadline)
    abort.abort()
    await eventCapture?.catch((error: unknown) => { failure ??= error })
    child?.stdin?.end()
    const signalGroup = (signal: NodeJS.Signals) => {
      if (!child?.pid) return
      try { process.kill(-child.pid, signal) }
      catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") failure ??= error
      }
    }
    if (!settled && child?.pid) signalGroup("SIGTERM")
    const kill = setTimeout(() => { forced = true; signalGroup("SIGKILL") }, 10000)
    const outcome = await exit?.catch((error: unknown) => {
      failure ??= error
      return { error: error instanceof Error ? error.message : "Spawn failure" }
    })
    clearTimeout(kill)
    signalGroup("SIGKILL")
    let providerStopped = false
    try { await provider.server[Symbol.asyncDispose](); providerStopped = true }
    catch (error) { failure ??= error instanceof Error ? error : new NativeFillFailure("Provider cleanup raised a non-Error value") }
    process.removeListener("SIGINT", onSignal)
    process.removeListener("SIGTERM", onSignal)
    save("cleanup.json", { ownedPID: child?.pid ?? null, ownedProcessGroup: child?.pid ?? null, outcome, forced, providerStopped, eventStreamAborted: true, socketsCreated: [], liveDatabaseAccess: false })
  }
  const skipped = z.object({ status: z.literal("skipped"), reason: z.string() }).safeParse(result)
  save("summary.json", { status: failure === undefined ? skipped.success ? "skipped" : "passed" : "failed", scenario: options.scenario, root: sandbox.root, result, ...(failure === undefined ? {} : { error: failure instanceof Error ? failure.message : "Non-Error failure" }) })
  if (failure !== undefined) throw new NativeFillFailure(sanitize(failure instanceof Error ? failure.message : "Scenario failed"))
  requireProof(result !== undefined, "Scenario produced no result")
  return result
}
