import * as logger from "../shared/logger"

export class UnsupportedV1ClientCallError extends Error {
  constructor(readonly method: string) {
    super(method)
    this.name = "UnsupportedV1ClientCallError"
  }
}

export function unsupportedV1Call(method: string): never {
  logger.log("[v2-bridge] unsupported v1 call", { method })
  throw new UnsupportedV1ClientCallError(method)
}

function unsupportedMethod(method: string): object {
  return new Proxy(() => unsupportedV1Call(method), {
    get: (_target, property) => unsupportedMethod(`${method}.${String(property)}`),
  })
}

export function guardV1Surface<T extends object>(target: T, path: string): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      if (property in object) return Reflect.get(object, property, receiver)
      return unsupportedMethod(path ? `${path}.${String(property)}` : String(property))
    },
  })
}
