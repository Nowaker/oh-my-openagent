import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import type { ParityContext, Sandbox } from "./contracts"

const eventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start"), pid: z.number(), home: z.string(), cwd: z.string() }),
  z.object({ kind: z.literal("list"), pid: z.number() }),
  z.object({ kind: z.literal("call"), pid: z.number(), challenge: z.string(), reject: z.boolean(), receipt: z.string(), digest: z.string() }),
  z.object({ kind: z.literal("exit"), pid: z.number(), reason: z.string() }),
])
const digest = (value: string) => createHash("sha256").update(value).digest("hex")

export function createMcpFixture(context: ParityContext) {
  let root: string | undefined
  let trace = ""
  let closing = false
  let watcher: ReturnType<typeof watch> | undefined
  const exited = Promise.withResolvers<void>()
  const events = () => existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map((line) => eventSchema.parse(JSON.parse(line))) : []
  const check = () => {
    const recorded = events()
    if (closing && recorded.filter((event) => event.kind === "start").every((start) => recorded.some((event) => event.kind === "exit" && event.pid === start.pid))) exited.resolve()
  }
  const alive = (pid: number) => {
    try { process.kill(pid, 0); return true }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return false; throw error }
  }
  return {
    events,
    prepare(sandbox: Sandbox) {
      root = sandbox.root
      trace = join(root, "mcp-trace.jsonl")
      writeFileSync(trace, "")
      watcher = watch(root, (_event, file) => { if (file === "mcp-trace.jsonl") check() })
      const entry = join(root, "mcp-fixture.mjs")
      const source = `import { McpServer } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js"))}
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))}
import { z } from ${JSON.stringify(import.meta.resolve("zod"))}
import { appendFileSync } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
const trace = ${JSON.stringify(trace)}
const record = (event) => appendFileSync(trace, JSON.stringify({ ...event, pid: process.pid }) + "\\n")
record({ kind: "start", home: process.env.HOME, cwd: process.cwd() })
let reason = "natural"
process.once("exit", () => record({ kind: "exit", reason }))
const server = new McpServer({ name: "parity-local-sdk", version: "1.0.0" })
server.registerTool("roundtrip", {
  description: "Record a challenge receipt or return an intentional SDK tool error.",
  inputSchema: { challenge: z.string(), reject: z.boolean() },
}, async ({ challenge, reject }) => {
  const receipt = randomUUID()
  const digest = createHash("sha256").update(challenge).digest("hex")
  record({ kind: "call", challenge, reject, receipt, digest })
  return { isError: reject, content: [{ type: "text", text: JSON.stringify({ receipt, digest, rejected: reject }) }] }
})
const shutdown = async (why) => { reason = why; await server.close(); process.exit(0) }
process.stdin.once("end", () => { void shutdown("stdin-end") })
process.once("SIGTERM", () => { void shutdown("SIGTERM") })
process.once("SIGINT", () => { void shutdown("SIGINT") })
const transport = new StdioServerTransport()
await server.connect(transport)
const receive = transport.onmessage
transport.onmessage = (message) => { if (message.method === "tools/list") record({ kind: "list" }); receive?.(message) }
`
      writeFileSync(entry, source)
      writeFileSync(join(root, "mcp-fixture-sha256.txt"), digest(source) + "\n")
      return { command: process.execPath, args: [entry], env: { ...sandbox.env } }
    },
    assertRoundtrip(challenge: string, native: string, rejected: boolean) {
      const calls = events().filter((event) => event.kind === "call").filter((event) => event.challenge === challenge && event.reject === rejected)
      assert.equal(calls.length, 1, "MCP handler did not independently receive exactly one expected call")
      const call = calls[0]
      assert.ok(call)
      assert.equal(call.digest, digest(challenge))
      assert.ok(native.includes(call.receipt), "Native tool result lost the independently generated MCP receipt")
      assert.ok(native.includes(call.digest), "Native tool result lost the challenge digest")
    },
    async [Symbol.asyncDispose]() {
      if (!root) return
      closing = true
      try {
        check()
        await context.harness.within(exited.promise, 5000, "MCP fixture process exit")
        const starts = events().filter((event) => event.kind === "start")
        const remaining = starts.filter((start) => alive(start.pid)).map((start) => start.pid)
        writeFileSync(join(root, "mcp-cleanup.json"), JSON.stringify({ starts, exits: events().filter((event) => event.kind === "exit"), remaining }, null, 2) + "\n")
        assert.deepEqual(remaining, [], "MCP fixture worker survived host disposal")
      } finally {
        watcher?.close()
        const forced = events().filter((event) => event.kind === "start" && alive(event.pid)).map((event) => event.pid)
        for (const pid of forced) process.kill(pid, "SIGKILL")
        writeFileSync(join(root, "mcp-disposal.json"), JSON.stringify({ recorded: events(), forced }, null, 2) + "\n")
      }
    },
  }
}
