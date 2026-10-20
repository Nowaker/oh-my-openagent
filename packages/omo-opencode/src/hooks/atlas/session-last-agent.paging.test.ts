import { describe, expect, test } from "bun:test"
import { getLastAgentFromSession } from "./session-last-agent"

type Message = {
  readonly info: { readonly id: string; readonly agent?: string; readonly time: { readonly created: number } }
  readonly parts?: readonly { readonly type: string }[]
}

function fixture(initial: Record<string, readonly Message[]>) {
  const histories = new Map(Object.entries(initial))
  const reads: number[] = []
  const anchors: (string | undefined)[] = []
  const client = {
    session: {
      async messages(input: { readonly path: { readonly id: string }; readonly query?: { readonly limit?: number; readonly before?: string } }) {
        const history = histories.get(input.path.id) ?? []
        const end = input.query?.before ? history.findIndex((message) => message.info.id === input.query?.before) : history.length
        const items = history.slice(0, end).slice(-(input.query?.limit ?? history.length))
        reads.push(items.length)
        anchors.push(input.query?.before)
        return { data: items }
      },
    },
  }
  return { histories, reads, anchors, resolve: (id: string) => getLastAgentFromSession(id, client, { isSqliteBackend: () => true }) }
}

function message(index: number, agent?: string): Message {
  return { info: { id: `msg_${index.toString().padStart(8, "0")}`, agent, time: { created: index } } }
}

describe("session agent bounded history", () => {
  test("selects the binary-newest nested ID when timestamps tie", async () => {
    // given
    const input = fixture({ main: [
      { info: { id: "msg_Z", agent: "Atlas", time: { created: 100 } } },
      { info: { id: "msg_a", agent: "Hephaestus", time: { created: 100 } } },
    ] })
    // when
    const agent = await input.resolve("main")
    // then
    expect(agent).toBe("hephaestus")
  })

  test("continues before the binary-oldest nested ID without overlapping a tied page", async () => {
    // given
    const input = fixture({ main: [
      { info: { id: "msg_0", agent: "Hephaestus", time: { created: 100 } } },
      ..."ABCDEFGHIJabcdefghij".split("").map((id) => ({ info: { id: `msg_${id}`, time: { created: 100 } } })),
    ] })
    // when
    const agent = await input.resolve("main")
    // then
    expect(agent).toBe("hephaestus")
    expect(input.anchors).toEqual([undefined, "msg_A"])
    expect(input.reads.reduce((sum, count) => sum + count, 0)).toBe(21)
  })

  test("reads only the newest page when a large session has a current agent", async () => {
    // given
    const input = fixture({ main: Array.from({ length: 2000 }, (_, index) => message(index, "Atlas")) })
    // when
    const agent = await input.resolve("main")
    // then
    expect(agent).toBe("atlas")
    expect(input.reads.reduce((sum, count) => sum + count, 0)).toBeLessThan(2000)
    expect(input.reads).toHaveLength(1)
  })

  test("reflects agent switches, removal and replacement without retaining another session's identity", async () => {
    // given
    const input = fixture({ main: [message(1, "Atlas")], other: [message(2, "Prometheus")] })
    expect(await input.resolve("main")).toBe("atlas")
    input.histories.set("main", [message(1, "Atlas"), message(3, "Hephaestus")])
    expect(await input.resolve("main")).toBe("hephaestus")
    input.histories.set("main", [message(1, "Atlas")])
    expect(await input.resolve("main")).toBe("atlas")
    input.histories.set("main", [message(4, "Sisyphus")])
    // when
    const agents = await Promise.all([input.resolve("main"), input.resolve("other")])
    // then
    expect(agents).toEqual(["sisyphus", "prometheus"])
  })

  test("walks past compaction and missing metadata to the newest real agent", async () => {
    // given
    const input = fixture({ main: [message(0, "Hephaestus"), ...Array.from({ length: 100 }, (_, index) => ({
      ...message(index + 1, index % 2 === 0 ? "Atlas" : undefined), parts: [{ type: "compaction" }],
    }))] })
    // when
    const agent = await input.resolve("main")
    // then
    expect(agent).toBe("hephaestus")
    expect(input.reads.length).toBeGreaterThan(1)
    expect(Math.max(...input.reads)).toBeLessThan(101)
  })

  test("returns null after exhausting pages without agent metadata", async () => {
    // given
    const input = fixture({ main: Array.from({ length: 100 }, (_, index) => message(index)) })
    // when
    const agent = await input.resolve("main")
    // then
    expect(agent).toBeNull()
    expect(input.reads.reduce((sum, count) => sum + count, 0)).toBe(100)
  })
})
