import { expect, test } from "bun:test"
import { findNearestMessageWithFieldsFromSDK, NEAREST_MESSAGE_RECENT_WINDOW, type SDKMessage } from "./sdk-message-lookup"

type MessagesInput = { readonly path: { readonly id: string }; readonly query?: { readonly limit?: number } }

function message(index: number, info: SDKMessage["info"]): SDKMessage {
  return { id: `msg_${String(index).padStart(6, "0")}`, info: { ...info, time: { created: index } }, parts: [] }
}

function fakeClient(history: readonly SDKMessage[]) {
  const calls: MessagesInput[] = []
  return {
    calls,
    client: {
      session: {
        messages: async (input: MessagesInput) => {
          calls.push(input)
          const limit = input.query?.limit
          return { data: limit === undefined ? history : history.slice(-limit) }
        },
      },
    },
  }
}

const complete = (agent: string) => ({ agent, model: { providerID: "anthropic", modelID: "claude-opus-5-5" } })

test("answers from the newest window without fetching the whole session", async () => {
  // given
  const history = Array.from({ length: 500 }, (_, index) => message(index, complete(index === 499 ? "atlas" : "sisyphus")))
  const { calls, client } = fakeClient(history)

  // when
  const result = await findNearestMessageWithFieldsFromSDK(client, "ses_long")

  // then
  expect(result?.agent).toBe("atlas")
  expect(calls).toEqual([{ path: { id: "ses_long" }, query: { limit: NEAREST_MESSAGE_RECENT_WINDOW } }])
})

test("falls back to the whole session when the window has no agent-and-model message", async () => {
  // given
  const history = [
    message(0, complete("atlas")),
    ...Array.from({ length: NEAREST_MESSAGE_RECENT_WINDOW }, (_, index) => message(index + 1, {})),
  ]
  const { calls, client } = fakeClient(history)

  // when
  const result = await findNearestMessageWithFieldsFromSDK(client, "ses_sparse")

  // then
  expect(result?.agent).toBe("atlas")
  expect(calls.map((call) => call.query?.limit)).toEqual([NEAREST_MESSAGE_RECENT_WINDOW, undefined])
})

test("keeps preferring an older complete message over a newer partial one", async () => {
  // given
  const history = [
    message(0, complete("atlas")),
    ...Array.from({ length: NEAREST_MESSAGE_RECENT_WINDOW }, (_, index) => message(index + 1, { agent: "partial" })),
  ]
  const { client } = fakeClient(history)

  // when
  const result = await findNearestMessageWithFieldsFromSDK(client, "ses_partial")

  // then
  expect(result?.agent).toBe("atlas")
})
