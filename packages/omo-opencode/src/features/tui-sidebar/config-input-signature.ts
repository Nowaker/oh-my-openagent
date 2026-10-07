import { lstatSync, statSync, type Stats } from "node:fs"
import { dirname, join, resolve } from "node:path"

import {
  MAX_PROJECT_CONFIG_DIRECTORY_DEPTH,
  resolveUserOmoConfigDirectory,
  type OmoConfigEnv,
} from "@oh-my-opencode/omo-config-core"

const CONFIG_FILE_NAMES = ["omo.jsonc", "omo.json"] as const
const CONFIG_ENV_KEYS = ["HOME", "USERPROFILE", "OMO_PROFILE", "OCX_PROFILE", "OPENCODE_CONFIG_DIR"] as const

function statStamp(stats: Stats | undefined): string {
  return stats === undefined ? "-" : `${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`
}

function pathStamp(path: string): string {
  const linkStats = lstatSync(path, { throwIfNoEntry: false })
  if (linkStats === undefined || !linkStats.isSymbolicLink()) {
    return statStamp(linkStats)
  }
  return `link>${statStamp(statSync(path, { throwIfNoEntry: false }))}`
}

function omoDirStamps(omoDir: string): string[] {
  const dirStats = lstatSync(omoDir, { throwIfNoEntry: false })
  if (dirStats === undefined) {
    return [`${omoDir}=-`]
  }
  return [
    `${omoDir}=${dirStats.isSymbolicLink() ? "link" : "dir"}`,
    ...CONFIG_FILE_NAMES.map((name) => `${join(omoDir, name)}=${pathStamp(join(omoDir, name))}`),
  ]
}

/**
 * Cheap fingerprint of every input `validatePluginConfig` reads: the user `.omo` layer, every
 * `.omo` from `directory` up to the filesystem root, and the env keys that pick home and profile.
 * Walking past `$HOME` only adds candidates the loader skips, so a change there costs one
 * recomputation and never hides a change the loader would see.
 */
export function configInputSignature(directory: string, environment: OmoConfigEnv = process.env): string {
  const parts = CONFIG_ENV_KEYS.map((key) => `${key}=${environment[key] ?? ""}`)
  parts.push(...omoDirStamps(resolveUserOmoConfigDirectory(environment)))

  let currentDir = resolve(directory)
  for (let depth = 0; depth < MAX_PROJECT_CONFIG_DIRECTORY_DEPTH; depth += 1) {
    parts.push(...omoDirStamps(join(currentDir, ".omo")))
    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) break
    currentDir = parentDir
  }
  return parts.join("\n")
}

/**
 * Wraps a per-directory computation so it reruns only when the config input signature changes.
 * The signature is taken before computing, so an edit landing mid-computation still differs from
 * the cached signature on the next call and triggers a fresh computation.
 */
export function memoizeByConfigInputs<T>(
  compute: (directory: string) => T,
  signatureOf: (directory: string) => string = (directory) => configInputSignature(directory),
): (directory: string) => T {
  let cached: { readonly directory: string; readonly signature: string; readonly value: T } | null = null
  return (directory) => {
    const signature = signatureOf(directory)
    if (cached !== null && cached.directory === directory && cached.signature === signature) {
      return cached.value
    }
    const value = compute(directory)
    cached = { directory, signature, value }
    return value
  }
}
