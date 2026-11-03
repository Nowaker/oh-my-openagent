const CONSUMERS_KEY = "__vibetermContinuationConsumersV1"

/** This registration describes constructed hooks, never installed files or configured intent. */
export function registerContinuationConsumer(client: object): () => void {
  const existing: unknown = Reflect.get(globalThis, CONSUMERS_KEY)
  const consumers = existing instanceof WeakMap ? existing : new WeakMap<object, unknown>()
  if (existing === undefined) Reflect.set(globalThis, CONSUMERS_KEY, consumers)
  if (existing !== undefined && !(existing instanceof WeakMap)) return () => {}
  const registration = { version: 1, todos: "scoped-v1", boulder: "scoped-v1" } as const
  consumers.set(client, registration)
  return () => {
    if (consumers.get(client) === registration) consumers.delete(client)
  }
}
