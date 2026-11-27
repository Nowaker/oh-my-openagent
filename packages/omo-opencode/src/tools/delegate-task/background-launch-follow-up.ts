import type { DelegateTaskArgs } from "./types"

export function backgroundLaunchFollowUp(wake: DelegateTaskArgs["wake"]): string {
  if (wake === "none") {
    return 'Do not wait for an ordinary completion to wake you: with wake "none", its notice is saved for your next turn, even if this is the last child. Errors, unrequested cancellations, and interruptions can still wake you. Carry on with other work or end your turn; do not poll with background_output.'
  }
  return "Carry on with other work or end your turn. Completion notices arrive as <system-reminder> messages, not necessarily in a new turn; do not poll with background_output."
}
