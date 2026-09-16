import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { bunFile } from "./file-shim.mjs"

const directory = await mkdtemp(join(import.meta.dirname, "file-shim-"))
try {
  for (const bytes of [new Uint8Array(), new Uint8Array([0, 255, 7]), new Uint8Array(10000).fill(123)]) {
    const path = join(directory, "bytes.bin")
    await writeFile(path, bytes)
    const value = await bunFile(path).arrayBuffer()
    assert(value instanceof ArrayBuffer)
    assert.deepEqual(new Uint8Array(value), bytes)
    if (value.byteLength) new Uint8Array(value)[0] = 42
    assert.deepEqual(new Uint8Array(await bunFile(path).arrayBuffer()), bytes)
  }
  console.log("Node fallback: empty, pooled-size, large byte ranges and independent buffers PASS")
} finally {
  await rm(directory, { recursive: true })
}
