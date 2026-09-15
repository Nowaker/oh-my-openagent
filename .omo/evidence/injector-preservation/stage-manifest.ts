import { readFileSync, writeFileSync } from "node:fs"
import { z } from "zod"

const path = z.string().min(1).parse(process.argv[2])
const version = z.string().regex(/^4\.19\.4-nowaker\.\d+$/).parse(process.argv[3])
const manifest = z.object({
  name: z.literal("oh-my-opencode"),
  version: z.literal("4.19.4"),
  optionalDependencies: z.record(z.string(), z.string()),
}).passthrough().parse(JSON.parse(readFileSync(path, "utf8")))
const optionalDependencies = Object.fromEntries(Object.entries(manifest.optionalDependencies).map(([name, value]) => [
  name.replace(/^oh-my-opencode-/, "oh-my-openagent-"), value,
]))
writeFileSync(path, JSON.stringify({ ...manifest, name: "oh-my-openagent", version, optionalDependencies }, null, 2) + "\n")
