import { nativeEvent, NativeFillFailure, requireProof } from "./v2-native-fills-contract"
import type { NativeEvent } from "./v2-native-fills-contract"

export class NativeEvents {
  readonly rows: NativeEvent[] = []
  private readonly listeners = new Set<() => void>()
  private failure: Error | undefined
  constructor(private readonly signal: AbortSignal, private readonly save: (name: string, value: unknown) => void) {}

  async consume(response: Response): Promise<void> {
    requireProof(response.ok && response.body, `SSE subscription failed: HTTP ${response.status}`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let pending = ""
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) {
          if (!this.signal.aborted) throw new NativeFillFailure("SSE stream closed during the scenario")
          return
        }
        pending += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n")
        let boundary: number
        while ((boundary = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, boundary)
          pending = pending.slice(boundary + 2)
          const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
          if (!data) continue
          this.rows.push(nativeEvent.parse(JSON.parse(data)))
          this.save("events.json", this.rows)
          for (const listener of this.listeners) listener()
        }
      }
    } catch (error) {
      if (this.signal.aborted) return
      if (!(error instanceof Error)) throw error
      this.failure = error
      for (const listener of this.listeners) listener()
    } finally {
      reader.releaseLock()
    }
  }

  wait = (predicate: (event: NativeEvent) => boolean, after = 0): Promise<NativeEvent> => new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer)
      this.listeners.delete(check)
      this.signal.removeEventListener("abort", aborted)
    }
    const check = () => {
      const match = this.rows.slice(after).find(predicate)
      if (match) { stop(); resolve(match) }
      else if (this.failure) { stop(); reject(this.failure) }
    }
    const aborted = () => { stop(); reject(new NativeFillFailure("Scenario aborted while waiting for a native event")) }
    const timer = setTimeout(() => { stop(); reject(new NativeFillFailure("Native event did not arrive within 90 seconds")) }, 90000)
    this.listeners.add(check)
    this.signal.addEventListener("abort", aborted, { once: true })
    if (this.signal.aborted) aborted()
    else check()
  })
}
