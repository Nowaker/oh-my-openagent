import { cpSync, lstatSync } from "node:fs"
import { join, relative, sep } from "node:path"

export function retainNativeScratch(input: { readonly root: string; readonly scratchRoot?: string }): void {
  if (!input.scratchRoot) return
  const scratch = input.scratchRoot
  cpSync(scratch, join(input.root, "native-scratch"), { recursive: true,
    filter: (source) => {
      const parts = relative(scratch, source).split(sep)
      const info = lstatSync(source)
      return (info.isFile() || info.isDirectory() || info.isSymbolicLink())
        && !parts.some((part) => ["bun-cache", "npm-cache", ".cache", "plugins"].includes(part))
        && !(parts[0] === "tmp" && parts.at(-1)?.startsWith(".bun-"))
    },
  })
}
