/**
 * The script-realm value boundary (ported from dsh-workflow-worker-thread
 * `realm.ts`). Values leaving the script vm are materialized into plain host
 * JSON data before they cross the worker boundary; thrown values of any realm
 * render to text without ever throwing.
 *
 * The walk rejects values JSON cannot preserve, but it trusts model-written
 * workflow scripts: getters and proxy traps may run, and the vm is not a
 * security boundary (the worker provides host-loop isolation and forced
 * termination, not hostile-value containment).
 *
 * SELF-CONTAINED factory ({@link createRealmKit}): serialized into the worker
 * source with `Function.prototype.toString()`, so it references nothing from
 * module scope.
 */

export interface MaterializeErrorLike extends Error {
  readonly path: string
  readonly reason: string
}

export interface RealmKit {
  MaterializeError: new (path: string, reason: string) => MaterializeErrorLike
  /**
   * Copy `value` (typically from the vm realm) into plain host JSON data.
   * Root `undefined` is returned unchanged; nested `undefined` and values JSON
   * cannot represent losslessly throw a `MaterializeError` naming the path.
   */
  materializeFromRealm(value: unknown, root?: string): unknown
  /** Render a thrown value (stack → message → String) without ever throwing. */
  renderThrown(error: unknown): string
}

/** Build the realm kit. SELF-CONTAINED (serialized into the worker source). */
export function createRealmKit(): RealmKit {
  class MaterializeError extends Error implements MaterializeErrorLike {
    readonly path: string
    readonly reason: string

    constructor(path: string, reason: string) {
      super(`${path}: ${reason}`)
      this.name = 'MaterializeError'
      this.path = path
      this.reason = reason
    }
  }

  const renderThrown = (error: unknown): string => {
    try {
      const stack = (error as { stack?: unknown } | null | undefined)?.stack
      if (typeof stack === 'string' && stack.length > 0) return stack
      const message = (error as { message?: unknown } | null | undefined)
        ?.message
      if (typeof message === 'string' && message.length > 0) return message
      return String(error)
    } catch {
      return '[unrenderable thrown value]'
    }
  }

  /** `null` prototype, or a prototype whose own prototype is `null` (any realm's Object.prototype). */
  const hasPlainPrototype = (value: object): boolean => {
    const proto: unknown = Object.getPrototypeOf(value)
    if (proto === null) return true
    return Object.getPrototypeOf(proto) === null
  }

  const materialize = (
    value: unknown,
    path: string,
    seen: Set<object>,
  ): unknown => {
    switch (typeof value) {
      case 'boolean':
      case 'string':
        return value
      case 'number':
        if (!Number.isFinite(value))
          throw new MaterializeError(
            path,
            'non-finite numbers are not JSON data',
          )
        return value
      case 'bigint':
        throw new MaterializeError(path, 'bigints are not JSON data')
      case 'function':
        throw new MaterializeError(path, 'functions are not plain JSON data')
      case 'symbol':
        throw new MaterializeError(path, 'symbols are not plain JSON data')
      case 'undefined':
        throw new MaterializeError(path, 'undefined is not JSON data')
      case 'object':
        break
    }
    if (value === null) return null
    const objectValue = value as object
    if (seen.has(objectValue))
      throw new MaterializeError(path, 'circular references are not JSON data')
    seen.add(objectValue)
    try {
      if (Array.isArray(objectValue)) {
        const out: unknown[] = []
        for (let index = 0; index < objectValue.length; index++) {
          if (!(index in objectValue))
            throw new MaterializeError(
              `${path}[${index}]`,
              'sparse arrays are not JSON data',
            )
          out.push(
            materialize(
              (objectValue as unknown[])[index],
              `${path}[${index}]`,
              seen,
            ),
          )
        }
        for (const key of Object.keys(objectValue)) {
          const index = Number(key)
          if (
            !Number.isInteger(index) ||
            index < 0 ||
            index >= objectValue.length
          )
            throw new MaterializeError(
              `${path}.${key}`,
              'arrays with non-index properties are not JSON data',
            )
        }
        if (Object.getOwnPropertySymbols(objectValue).length > 0)
          throw new MaterializeError(
            path,
            'symbol-keyed properties are not plain JSON data',
          )
        return out
      }
      if (!hasPlainPrototype(objectValue))
        throw new MaterializeError(
          path,
          'only plain objects and arrays are JSON data (exotic prototype)',
        )
      if (Object.getOwnPropertySymbols(objectValue).length > 0)
        throw new MaterializeError(
          path,
          'symbol-keyed properties are not plain JSON data',
        )
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(objectValue)) {
        // defineProperty, never assignment: "__proto__" must become an OWN data property.
        Object.defineProperty(out, key, {
          value: materialize(
            (objectValue as Record<string, unknown>)[key],
            `${path}.${key}`,
            seen,
          ),
          enumerable: true,
          writable: true,
          configurable: true,
        })
      }
      return out
    } finally {
      seen.delete(objectValue)
    }
  }

  const materializeFromRealm = (value: unknown, root = 'value'): unknown => {
    if (value === undefined) return undefined
    try {
      return materialize(value, root, new Set())
    } catch (error: unknown) {
      if (error instanceof MaterializeError) throw error
      throw new MaterializeError(
        root,
        `reading the value threw: ${renderThrown(error)}`,
      )
    }
  }

  return { MaterializeError, materializeFromRealm, renderThrown }
}

/** The host-side kit instance. */
export const realm: RealmKit = createRealmKit()
