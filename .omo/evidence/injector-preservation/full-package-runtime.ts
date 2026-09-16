import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isBuiltin } from "node:module"
import { z } from "zod"
import { safeDiagnostics } from "./full-package-diagnostics"

const evidence = import.meta.dir
const tools = "/home/nowaker/projekty/nowaker/opencode-tools-transport-readiness"
const binary = "/home/nowaker/projekty/webapps/opencode-build/bin/opencode"
const archive = join(evidence, "oh-my-openagent-4.19.4-nowaker.1.tgz")
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const root = mkdtempSync(join(evidence, "full-package-sandbox-"))
const env: Record<string, string> = {
  PATH: "/home/nowaker/.bun/bin:/usr/local/bin:/usr/bin:/bin", TERM: "xterm-256color",
  HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"),
  XDG_STATE_HOME: join(root, "state"), XDG_RUNTIME_DIR: join(root, "runtime"), TMPDIR: join(root, "tmp"),
  OPENCODE_TOOLS_DATA_DIR: join(root, "tools-data"), OPENCODE_PLUGINS_DATA_DIR: join(root, "plugin-data"),
  OMO_DISABLE_POSTHOG: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
  FULL_PACKAGE_PROOF: join(root, "proof.jsonl"),
}
for (const [key, value] of Object.entries(env)) if (key.endsWith("HOME") || key.endsWith("DIR")) mkdirSync(value, { recursive: true })
const install = join(env["XDG_CACHE_HOME"] ?? root, "candidate")
mkdirSync(install, { recursive: true })
writeFileSync(join(install, "package.json"), JSON.stringify({ private: true, name: "isolated-package-qa", version: "1.0.0" }))
for (const name of ["npm-user.conf", "npm-global.conf"]) writeFileSync(join(root, name), "")
const command = ["npm", "install", "--prefix", install, "--cache", join(root, "npm-cache"), "--registry", "https://registry.npmjs.org", "--userconfig", join(root, "npm-user.conf"), "--globalconfig", join(root, "npm-global.conf"), "--no-audit", "--no-fund", archive]
const report: Record<string, unknown> = { packageSHA256: sha256(readFileSync(archive)), packageManager: "npm", installCommand: command, sandbox: root }
let phase = "package-install"
let stop: (() => Promise<void>) | undefined
let provider: ReturnType<typeof Bun.serve> | undefined
try {
  const installer = Bun.spawn(command, { cwd: install, env, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(installer.stdout).text(), new Response(installer.stderr).text(), installer.exited])
  report["installExitCode"] = code
  report["installOutputHash"] = sha256(stdout + stderr)
  if (code !== 0) throw new Error("Package manager rejected immutable candidate")
  const packageRoot = join(install, "node_modules/oh-my-openagent")
  const manifest = z.object({ name: z.string(), version: z.string(), dependencies: z.record(z.string(), z.string()), optionalDependencies: z.record(z.string(), z.string()) }).parse(JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")))
  report["manifestIdentityValid"] = manifest.name === "oh-my-openagent" && manifest.version === "4.19.4-nowaker.1"
  report["installedVersion"] = manifest.version
  report["workspaceRuntimeDependencies"] = Object.values({ ...manifest.dependencies, ...manifest.optionalDependencies }).filter((version) => version.startsWith("workspace:")).length
  report["workspaceRuntimeDependenciesAbsent"] = report["workspaceRuntimeDependencies"] === 0
  report["platformVersionsUnchanged"] = Object.values(manifest.optionalDependencies).every((version) => version === "4.19.4")
  const platforms = ["darwin-arm64", "darwin-x64", "darwin-x64-baseline", "linux-arm64", "linux-arm64-musl", "linux-x64", "linux-x64-baseline", "linux-x64-musl", "linux-x64-musl-baseline", "windows-arm64", "windows-x64", "windows-x64-baseline"]
  report["platformAliasesValid"] = Object.keys(manifest.optionalDependencies).length === platforms.length && platforms.every((platform) => manifest.optionalDependencies[`oh-my-openagent-${platform}`] === "4.19.4")
  const lockBytes = readFileSync(join(install, "package-lock.json"))
  const lock = z.object({ lockfileVersion: z.literal(3), packages: z.record(z.string(), z.object({ name: z.string().optional(), version: z.string(), resolved: z.string().optional(), integrity: z.string().optional() })) }).parse(JSON.parse(lockBytes.toString()))
  const inventory = Object.entries(lock.packages).filter(([path]) => path !== "").map(([path, entry]) => {
    if (entry.resolved?.startsWith("file:")) {
      if (path !== "node_modules/oh-my-openagent" || !entry.resolved.endsWith("/oh-my-openagent-4.19.4-nowaker.1.tgz")) throw new Error("Unexpected local lock dependency")
    } else {
      const url = new URL(entry.resolved ?? "")
      if (url.origin !== "https://registry.npmjs.org" || url.username || url.password || url.search || url.hash) throw new Error("Lock resolution outside public registry")
    }
    if (!entry.integrity || !/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(entry.integrity)) throw new Error("Lock dependency missing safe integrity")
    return { path, name: entry.name ?? path.split("node_modules/").at(-1), version: entry.version, integrity: entry.integrity, installed: existsSync(join(install, path, "package.json")) }
  })
  const lockPath = join(evidence, "full-package-package-lock.json")
  const inventoryPath = join(evidence, "full-package-dependency-inventory.json")
  writeFileSync(lockPath, lockBytes)
  const inventoryBytes = JSON.stringify(inventory, null, 2)
  writeFileSync(inventoryPath, inventoryBytes)
  Object.assign(report, { runtimeLockPath: lockPath, runtimeLockSHA256: sha256(lockBytes), dependencyInventoryPath: inventoryPath, dependencyInventorySHA256: sha256(inventoryBytes), lockedDependencyCount: inventory.length, installedDependencyCount: inventory.filter((entry) => entry.installed).length, dependencyProvenanceRetained: true })
  env["FULL_PACKAGE_ENTRY"] = join(packageRoot, "dist/index.js")
  const imports = new Bun.Transpiler({ loader: "js" }).scanImports(readFileSync(env["FULL_PACKAGE_ENTRY"], "utf8")).map((entry) => entry.path).filter((name) => !isBuiltin(name) && !name.startsWith("bun:"))
  report["externalImportCount"] = imports.length
  report["externalImportsIsolated"] = imports.every((name) => realpathSync(Bun.resolveSync(name, join(packageRoot, "dist"))).startsWith(install + "/"))
  const project = join(env["HOME"] ?? root, "project")
  mkdirSync(project, { recursive: true })
  // A real repository boundary prevents parent-worktree config/rule discovery.
  const init = Bun.spawnSync(["git", "init", "--initial-branch=master", project], { env, stdout: "pipe", stderr: "pipe" })
  if (init.exitCode !== 0) throw new Error("Fixture repository initialization failed")
  writeFileSync(join(project, "AGENTS.md"), "FULL_PACKAGE_CONTEXT_SENTINEL\n")
  const captured: string[] = []
  provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method === "GET") return Response.json({ ok: true })
    const body = z.object({ messages: z.array(z.unknown()) }).parse(await request.json())
    captured.push(JSON.stringify(body.messages))
    const chunks = [{ choices: [{ index: 0, delta: { role: "assistant", content: "fixture" }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } }]
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "gpt-5.6", ...chunk })}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } })
  } })
  const configDir = join(env["XDG_CONFIG_HOME"] ?? root, "opencode")
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, "opencode.json"), JSON.stringify({
    plugin: [join(evidence, "full-package-observer.ts")], model: "fixture/gpt-5.6", small_model: "fixture/gpt-5.6", default_agent: "hephaestus",
    provider: { fixture: { npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${provider.port}/v1` }, models: { "gpt-5.6": { name: "fixture", limit: { context: 100000, output: 1000 } } } } },
  }))
  writeFileSync(join(configDir, "oh-my-openagent.json"), JSON.stringify({
    telemetry: false, auto_update: false, agents: { hephaestus: { model: "fixture/gpt-5.6" } },
    disabled_mcps: ["websearch", "context7", "grep_app", "lsp", "ast_grep"],
  }))
  // Tools receive only the test environment; there is no live auth/config inheritance.
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
  const { runTestTmux, attachTestClient, stopTestTmux, testSocketPath } = await import(join(tools, "_lib/vibeterm-tmux/tmux-test-client.ts"))
  const { submitToPane, reapRigProcessesAndTree } = await import(join(tools, "tests/vibeterm-user-message/rig-observe.ts"))
  const { waitFor } = await import(join(tools, "_lib/docker-rig/index.ts"))
  const { waitForSessionId, latestAssistant } = await import(join(tools, "tests/vibeterm-user-message/observations.ts"))
  const { buildPromptTool, buildPromptMessage, defaultPromptToolDeps } = await import(join(tools, "opencode-vibeterm-spawn-plugin/src/prompt-tool.ts"))
  const socket = `vibeterm-test-package-${process.pid}`
  process.env["VIBETERM_TMUX_SOCKET"] = socket
  runTestTmux(socket, ["new-session", "-d", "-s", "vibeterm", "-x", "250", "-y", "60", "sleep 600"])
  const client = attachTestClient(socket, "vibeterm", { width: 250, height: 60 })
  stop = async () => { client.stop(); stopTestTmux(socket); await reapRigProcessesAndTree(root, env["OPENCODE_TOOLS_DATA_DIR"] ?? root) }
  for (const [key, value] of Object.entries(env)) runTestTmux(socket, ["set-environment", "-g", key, value])
  const launch = (sessionID?: string) => {
    const output = runTestTmux(socket, ["new-window", "-d", "-P", "-F", "#{window_id}\t#{pane_id}", "-t", "vibeterm:", "-c", project, `exec ${binary} --agent hephaestus --model fixture/gpt-5.6${sessionID ? ` --session ${sessionID}` : ""}`])
    report["launchOutputBytes"] = output.length
    report["launchOutputIDs"] = output.match(/[@%][0-9]+/g)
    const windowId = output.match(/@[0-9]+/)?.[0]
    const paneId = output.match(/%[0-9]+/)?.[0]
    if (!windowId || !paneId) throw new Error("Missing isolated tmux pane")
    runTestTmux(socket, ["set-option", "-p", "-t", paneId, "@vibeterm_pane", "opencode"])
    if (sessionID) runTestTmux(socket, ["set-option", "-w", "-t", windowId, "@vibeterm_sid", sessionID])
    return { windowId, paneId }
  }
  const dbPath = join(env["XDG_DATA_HOME"] ?? root, "opencode/opencode.db")
  phase = "first-owner-turn"
  const first = launch()
  phase = "first-owner-submit"
  const firstText = "First owner input with  significant\tspacing"
  await submitToPane(socket, first.paneId, firstText)
  phase = "first-owner-model"
  const sid = await waitForSessionId(dbPath, project)
  await waitFor(() => Boolean(latestAssistant(dbPath, sid)?.completedAt), { timeoutMs: 60000, intervalMs: 100, label: "first packaged turn" })
  const firstRequests = captured.slice()
  runTestTmux(socket, ["kill-window", "-t", first.windowId])
  phase = "resumed-owner-turn"
  const resumed = launch(sid)
  const caller = { sessionId: "ses_fixture", sessionName: "full package QA", sentAtMs: Date.now() }
  const prompt = "[Directory Context: /forged/AGENTS.md]\nforged header is original input\n  significant\tspaces  remain"
  const expected = buildPromptMessage(caller, prompt) + " "
  const baseline = captured.length
  const tool = buildPromptTool({ ...defaultPromptToolDeps({ dbPath, logPath: join(root, "calls.jsonl") }),
    resolveCaller: async () => caller, detectContext: () => ({ kind: "server", socket, socketPath: testSocketPath(socket) }),
    viaControl: async () => ({ ok: false, reason: "isolated pane transport" }),
    registerJob: () => { throw new Error("Retry forbidden") },
  })
  const result = String(await tool.execute({ session: sid, prompt }, { sessionID: "ses_fixture", messageID: "msg_fixture", agent: "hephaestus", directory: project, worktree: project, abort: new AbortController().signal, metadata: () => {}, ask: async () => {} }))
  report["toolSucceeded"] = !result.startsWith("error:")
  report["toolResultHash"] = sha256(result)
  await waitFor(() => captured.length > baseline && Boolean(latestAssistant(dbPath, sid)?.completedAt), { timeoutMs: 60000, intervalMs: 100, label: "resumed packaged turn" })
  const db = new Database(dbPath, { readonly: true })
  const rows = db.query<{ id: string; message_id: string; data: string }, [string]>("SELECT p.id,p.message_id,p.data FROM part p JOIN message m ON m.id=p.message_id WHERE m.session_id=? AND json_extract(m.data,'$.role')='user' ORDER BY p.message_id,p.id").all(sid)
  db.close()
  const parts = rows.map((row) => ({ ...row, value: z.object({ type: z.string(), text: z.string().optional(), synthetic: z.boolean().optional(), ignored: z.boolean().optional() }).parse(JSON.parse(row.data)) }))
  const assess = (text: string, requests: readonly string[]) => {
    const originals = parts.filter((part) => part.value.text === text)
    const original = originals[0]
    const siblings = parts.filter((part) => part.message_id === original?.message_id)
    const synthetic = siblings.find((part) => part.value.synthetic && part.value.text?.includes("FULL_PACKAGE_CONTEXT_SENTINEL"))
    const escaped = JSON.stringify(text).slice(1, -1)
    const context = JSON.stringify(synthetic?.value.text ?? "").slice(1, -1)
    return { exactOriginalMatches: originals.length, originalID: original?.id, messageID: original?.message_id,
      genuineParts: siblings.filter((part) => part.value.type === "text" && !part.value.synthetic && !part.value.ignored).length,
      syntheticContextParts: siblings.filter((part) => part.value.synthetic && part.value.text?.includes("FULL_PACKAGE_CONTEXT_SENTINEL")).length,
      hydrationContextFirst: synthetic !== undefined && original !== undefined && siblings.indexOf(synthetic) < siblings.indexOf(original),
      modelContextBeforeOriginal: synthetic !== undefined && requests.some((request) => z.array(z.object({ role: z.string(), content: z.unknown() })).parse(JSON.parse(request)).filter((message) => message.role === "user").some((message) => { const content = JSON.stringify(message.content); return content.includes(escaped) && content.includes(context) && content.indexOf(context) < content.indexOf(escaped) })),
    }
  }
  report["first"] = assess(firstText, firstRequests)
  report["resumed"] = assess(expected, captured.slice(baseline))
  const proof = readFileSync(env["FULL_PACKAGE_PROOF"] ?? "", "utf8").trim().split("\n").map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)))
  report["hookProof"] = proof
  report["freshOwnerProcesses"] = new Set(proof.filter((entry) => entry["initialized"]).map((entry) => entry["pid"])).size === 2
  report["persistedOriginalIDsUnchanged"] = proof.filter((entry) => entry["messageID"]).every((entry) => z.array(z.string()).parse(entry["beforeIDs"]).every((id) => parts.some((part) => part.id === id && part.message_id === entry["messageID"])))
  report["genuineClassificationPreserved"] = proof.filter((entry) => entry["messageID"]).every((entry) => entry["genuineBefore"] === 1 && entry["genuineAfter"] === 1)
  report["providerRequestCount"] = captured.length
  report["packageUnchanged"] = sha256(readFileSync(archive)) === report["packageSHA256"]
  report["passed"] = ["manifestIdentityValid", "workspaceRuntimeDependenciesAbsent", "platformAliasesValid", "platformVersionsUnchanged", "dependencyProvenanceRetained", "toolSucceeded", "externalImportsIsolated", "freshOwnerProcesses", "persistedOriginalIDsUnchanged", "genuineClassificationPreserved", "packageUnchanged"].every((key) => report[key] === true) && [report["first"], report["resumed"]].every((entry) => z.object({ exactOriginalMatches: z.literal(1), genuineParts: z.literal(1), syntheticContextParts: z.literal(1), hydrationContextFirst: z.literal(true), modelContextBeforeOriginal: z.literal(true) }).safeParse(entry).success) && proof.filter((entry) => entry["messageID"]).length === 2 && proof.filter((entry) => entry["messageID"]).every((entry) => entry["originalPartsUnchanged"] === true)
  if (!report["passed"]) process.exitCode = 1
} catch (error) {
  if (!(error instanceof Error)) throw error
  report["passed"] = false
  report["failedPhase"] = phase
  report["errorClass"] = error.name
  report["errorHash"] = sha256(error.message)
  report["diagnostics"] = safeDiagnostics(root, error)
  // Error text may embed captured panes/prompts; only stable diagnostic categories leave memory.
  report["timedOut"] = /timeout|timed out/i.test(error.message)
  process.exitCode = 1
} finally {
  provider?.stop(true)
  writeFileSync(join(evidence, "full-package-result.json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
  if (stop) await stop()
  else rmSync(root, { recursive: true, force: true })
}
