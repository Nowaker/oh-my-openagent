import * as Plugin from "@opencode/plugin/promise/plugin"

import { setupV2Bridge } from "../plugin-v2"

export const opencodeV2Server = Plugin.define({
  id: "oh-my-openagent",
  setup: setupV2Bridge,
})
