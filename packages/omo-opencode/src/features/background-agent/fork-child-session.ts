type ForkSessionResult =
  | { readonly data: { readonly id: string }; readonly error?: undefined }
  | { readonly data?: undefined; readonly error: unknown }

export type ForkSessionClient = {
  readonly session: {
    readonly fork?: (input: {
      readonly path: { readonly id: string }
      readonly body: Record<string, unknown>
      readonly query?: { readonly directory?: string }
    }) => Promise<ForkSessionResult>
  }
}

/**
 * Creates a subagent session as a copy of its parent, for `task(subagent_type: "fork")`. The parent is mid-turn while
 * its task call runs, so the copy leaves out the assistant message still streaming (`unsettled: "exclude"`): the child
 * sees the conversation up to the parent's last finished step. `parentID`, `title` and `permission` need the opencode
 * fork's session.fork (`db917f0795`); the plugin SDK predates them, hence the untyped body.
 */
export async function forkParentAsChildSession(
  client: ForkSessionClient,
  input: {
    readonly parentSessionID: string
    readonly title: string
    readonly directory: string
    readonly permission?: readonly unknown[]
  },
): Promise<string> {
  const fork = client.session.fork
  if (typeof fork !== "function") throw new Error("this opencode cannot fork a session")
  const body: Record<string, unknown> = {
    unsettled: "exclude",
    parentID: input.parentSessionID,
    title: input.title,
    ...(input.permission ? { permission: input.permission } : {}),
  }
  const result = await fork.call(client.session, {
    path: { id: input.parentSessionID },
    body,
    query: { directory: input.directory },
  })
  if (result.error !== undefined || !result.data) {
    throw new Error(`Failed to fork the parent session: ${JSON.stringify(result.error)}`)
  }
  return result.data.id
}
