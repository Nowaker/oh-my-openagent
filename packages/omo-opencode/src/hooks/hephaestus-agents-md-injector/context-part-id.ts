import { randomBytes } from "node:crypto"

const NATIVE_PART_ID = /^prt_([0-9a-f]{12})[0-9A-Za-z]{14}$/
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

export class ContextPartOrderingError extends Error {
  constructor() {
    super("AGENTS context requires an orderable native OpenCode part ID")
    this.name = "ContextPartOrderingError"
  }
}

export function createContextPartId(originalId: unknown, existingIds: readonly unknown[]): string {
  const match = typeof originalId === "string" ? NATIVE_PART_ID.exec(originalId) : null
  const encodedTime = match?.[1]
  if (!encodedTime || BigInt(`0x${encodedTime}`) === 0n) throw new ContextPartOrderingError()

  // Native OpenCode IDs are 12 hex time/counter digits plus 14 random base62 digits.
  // A lower time/counter field sorts before the untouched original for every random suffix.
  const prefix = (BigInt(`0x${encodedTime}`) - 1n).toString(16).padStart(12, "0")
  for (let attempt = 0; attempt < 8; attempt++) {
    const suffix = Array.from(randomBytes(14), (byte) => BASE62.charAt(byte % BASE62.length)).join("")
    const id = `prt_${prefix}${suffix}`
    if (!existingIds.includes(id)) return id
  }
  throw new ContextPartOrderingError()
}
