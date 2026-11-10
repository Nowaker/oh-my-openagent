import { isRecord } from "../../shared/record-type-guard"

type InternalPost = (options: {
  url: string
  path?: Record<string, unknown>
  query?: Record<string, unknown>
}) => Promise<unknown>

/**
 * Stops a running background job through the opencode fork's `POST /experimental/background/{jobID}/cancel`. The
 * plugin's SDK predates the route, so the call goes through the SDK's own transport, which also works in a tab that
 * runs without an HTTP port. Resolves true when a running job was stopped.
 */
export async function cancelBackgroundJob(client: unknown, directory: string, jobID: string): Promise<boolean> {
  const internal = isRecord(client) ? client["_client"] : undefined
  const post = isRecord(internal) ? internal["post"] : undefined
  if (typeof post !== "function") throw new Error("this opencode client cannot reach the background job route")
  const response = await (post as InternalPost).call(internal, {
    url: "/experimental/background/{jobID}/cancel",
    path: { jobID },
    query: { directory },
  })
  if (isRecord(response) && response["error"] !== undefined) {
    throw new Error(`opencode refused to stop ${jobID}: ${JSON.stringify(response["error"])}`)
  }
  return isRecord(response) && response["data"] === true
}
