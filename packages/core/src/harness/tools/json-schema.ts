/**
 * Enforced JSON Schema subset for structured subagent / workflow outputs
 * (ported from dsh-tools `json-schema.ts`): one scalar `type`, object
 * `properties`/`required`/boolean `additionalProperties`, array `items`,
 * type-correct scalar `enum`/`const`, exact-one `oneOf`, and annotations
 * (`description`/`title`/`default`/`examples`). Anything else rejects rather
 * than being accepted without enforcement.
 *
 * The implementation is ONE self-contained factory ({@link createJsonSchemaKit})
 * that references nothing from module scope: the workflow worker serializes it
 * with `Function.prototype.toString()` into its eval'd source, while the host
 * calls it directly ({@link jsonSchema}). Keep it free of imports, enums, and
 * module-level helpers.
 */

/** Scalar JSON values supported by `enum` and `const`. */
export type JsonSchemaScalar = string | number | boolean | null

/** Single-type keywords accepted by the enforced subset. */
export type JsonSchemaType =
  'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'

/** One raw JSON Schema node in the enforced subset. */
export interface JsonSchemaNode {
  type?: JsonSchemaType
  oneOf?: JsonSchemaNode[]
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  additionalProperties?: boolean
  items?: JsonSchemaNode
  enum?: JsonSchemaScalar[]
  const?: JsonSchemaScalar
  description?: string
  title?: string
  default?: unknown
  examples?: unknown
}

/** A consumer-constrained object-rooted schema. */
export type ObjectJsonSchema = JsonSchemaNode & { type: 'object' }

/** Thrown for a schema outside the subset; `violations` lists every offending path. */
export interface JsonSchemaErrorLike extends Error {
  readonly code: 'UNSUPPORTED_SCHEMA'
  readonly violations: string[]
}

export interface JsonSchemaKit {
  JsonSchemaError: new (violations: string[]) => JsonSchemaErrorLike
  /** Assert the subset (any root). */
  assertSupportedJsonSchema(schema: unknown): asserts schema is JsonSchemaNode
  /** Assert the subset plus an object root (structured output). */
  assertObjectJsonSchema(schema: unknown): asserts schema is ObjectJsonSchema
  /** Path-qualified violations of `value` against an asserted schema; empty = valid. */
  validateJsonSchemaValue(
    schema: JsonSchemaNode,
    value: unknown,
    path?: string,
  ): string[]
}

/**
 * Build the JSON-schema kit. SELF-CONTAINED: serialized into the workflow
 * worker source, so it must not reference anything outside its own body.
 */
export function createJsonSchemaKit(): JsonSchemaKit {
  class JsonSchemaError extends Error implements JsonSchemaErrorLike {
    readonly code: 'UNSUPPORTED_SCHEMA'
    readonly violations: string[]

    constructor(violations: string[]) {
      super(`unsupported JSON schema: ${violations.join('; ')}`)
      this.name = 'JsonSchemaError'
      this.code = 'UNSUPPORTED_SCHEMA'
      this.violations = violations
    }
  }

  const CONSTRAINTS = new Set([
    'type',
    'oneOf',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'enum',
    'const',
  ])
  const ANNOTATIONS = new Set(['description', 'title', 'default', 'examples'])
  const TYPES = [
    'object',
    'array',
    'string',
    'number',
    'integer',
    'boolean',
    'null',
  ]
  const ONE_OF_SIBLINGS = [
    'properties',
    'required',
    'additionalProperties',
    'items',
    'enum',
    'const',
  ]
  const TYPED_KEYWORDS: Record<string, string[]> = {
    properties: ['object'],
    required: ['object'],
    additionalProperties: ['object'],
    items: ['array'],
    enum: ['string', 'number', 'integer', 'boolean', 'null'],
    const: ['string', 'number', 'integer', 'boolean', 'null'],
  }

  /** Plain data object of any realm (null prototype or a prototype whose parent is null). */
  const isRecord = (value: unknown): value is Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return false
    try {
      const proto: unknown = Object.getPrototypeOf(value)
      return proto === null || Object.getPrototypeOf(proto) === null
    } catch {
      return false
    }
  }
  const has = (value: object, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(value, key)
  const isJsonNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)
  const scalarMatches = (type: string, value: unknown): boolean => {
    switch (type) {
      case 'string':
        return typeof value === 'string'
      case 'number':
        return isJsonNumber(value)
      case 'integer':
        return isJsonNumber(value) && Number.isInteger(value)
      case 'boolean':
        return typeof value === 'boolean'
      case 'null':
        return value === null
      default:
        return false
    }
  }
  /** Lossless JSON data check (annotations and unconstrained nodes). */
  const isJson = (value: unknown, seen: Set<object>): boolean => {
    if (value === null) return true
    switch (typeof value) {
      case 'string':
      case 'boolean':
        return true
      case 'number':
        return isJsonNumber(value)
      case 'object':
        break
      default:
        return false
    }
    const object = value as object
    if (seen.has(object)) return false
    seen.add(object)
    try {
      if (Array.isArray(object)) {
        for (let index = 0; index < object.length; index++) {
          if (!(index in object) || !isJson(object[index], seen)) return false
        }
        return true
      }
      if (!isRecord(object)) return false
      for (const key of Object.keys(object)) {
        if (!isJson(object[key], seen)) return false
      }
      return true
    } finally {
      seen.delete(object)
    }
  }
  const safeIsJson = (value: unknown): boolean => {
    try {
      return isJson(value, new Set())
    } catch {
      return false
    }
  }

  const checkNode = (
    node: unknown,
    path: string,
    violations: string[],
    seen: Set<object>,
  ): void => {
    if (!isRecord(node)) {
      violations.push(`${path} must be a schema object`)
      return
    }
    if (seen.has(node)) {
      violations.push(`${path} is circular`)
      return
    }
    seen.add(node)
    try {
      for (const key of Object.keys(node)) {
        if (CONSTRAINTS.has(key)) continue
        if (ANNOTATIONS.has(key)) {
          if (!safeIsJson(node[key]))
            violations.push(
              `${path}.${key} annotation must be lossless JSON data`,
            )
          continue
        }
        violations.push(
          `${path}.${key} is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`,
        )
      }
      if (has(node, 'description') && typeof node.description !== 'string')
        violations.push(`${path}.description must be a string`)
      if (has(node, 'title') && typeof node.title !== 'string')
        violations.push(`${path}.title must be a string`)
      const hasType = has(node, 'type')
      const hasOneOf = has(node, 'oneOf')
      if (hasType && hasOneOf) {
        violations.push(`${path} cannot declare both type and oneOf`)
        return
      }
      if (!hasType && !hasOneOf) {
        for (const key of ONE_OF_SIBLINGS) {
          if (has(node, key))
            violations.push(`${path}.${key} requires type or oneOf`)
        }
        return
      }
      if (hasOneOf) {
        const oneOf = node.oneOf
        if (!Array.isArray(oneOf) || oneOf.length < 2) {
          violations.push(
            `${path}.oneOf must be an array of at least two schemas`,
          )
        } else {
          oneOf.forEach((branch, index) => {
            checkNode(branch, `${path}.oneOf[${index}]`, violations, seen)
          })
        }
        for (const key of ONE_OF_SIBLINGS) {
          if (has(node, key))
            violations.push(`${path}.${key} is not supported beside oneOf`)
        }
        return
      }
      const type = node.type
      if (typeof type !== 'string' || !TYPES.includes(type)) {
        violations.push(
          Array.isArray(type)
            ? `${path}.type must be a single type string (type arrays are not supported)`
            : `${path}.type must be one of ${TYPES.join('/')}`,
        )
        return
      }
      for (const [key, types] of Object.entries(TYPED_KEYWORDS)) {
        if (has(node, key) && !types.includes(type))
          violations.push(`${path}.${key} is not supported on type "${type}"`)
      }
      if (type === 'object') {
        const properties = has(node, 'properties') ? node.properties : undefined
        if (has(node, 'properties')) {
          if (!isRecord(properties)) {
            violations.push(`${path}.properties must be an object of schemas`)
          } else {
            for (const [key, child] of Object.entries(properties))
              checkNode(child, `${path}.properties.${key}`, violations, seen)
          }
        }
        if (has(node, 'required')) {
          const required = node.required
          if (
            !Array.isArray(required) ||
            required.some((entry) => typeof entry !== 'string')
          ) {
            violations.push(`${path}.required must be an array of strings`)
          } else {
            const declared = isRecord(properties) ? properties : {}
            for (const key of required as string[]) {
              if (!has(declared, key))
                violations.push(
                  `${path}.required names "${key}" which is not in properties`,
                )
            }
          }
        }
        if (
          has(node, 'additionalProperties') &&
          typeof node.additionalProperties !== 'boolean'
        )
          violations.push(`${path}.additionalProperties must be a boolean`)
        return
      }
      if (type === 'array') {
        if (has(node, 'items'))
          checkNode(node.items, `${path}.items`, violations, seen)
        return
      }
      const allowed = has(node, 'enum') ? node.enum : undefined
      const enumValid =
        Array.isArray(allowed) &&
        allowed.length > 0 &&
        allowed.every((entry) => scalarMatches(type, entry))
      if (has(node, 'enum') && !enumValid)
        violations.push(
          `${path}.enum must be a non-empty array of ${type} values`,
        )
      if (has(node, 'const')) {
        if (!scalarMatches(type, node.const))
          violations.push(`${path}.const must be a ${type} value`)
        else if (enumValid && !(allowed as unknown[]).includes(node.const))
          violations.push(
            `${path}.const must be one of ${path}.enum when both are declared`,
          )
      }
    } finally {
      seen.delete(node)
    }
  }

  function assertSupportedJsonSchema(
    schema: unknown,
  ): asserts schema is JsonSchemaNode {
    const violations: string[] = []
    checkNode(schema, 'schema', violations, new Set())
    if (violations.length > 0) throw new JsonSchemaError(violations)
  }

  function assertObjectJsonSchema(
    schema: unknown,
  ): asserts schema is ObjectJsonSchema {
    const violations: string[] = []
    checkNode(schema, 'schema', violations, new Set())
    if (
      violations.length === 0 &&
      (!isRecord(schema) || schema.type !== 'object')
    )
      violations.push(
        'schema.type must be "object" (structured output is object-rooted)',
      )
    if (violations.length > 0) throw new JsonSchemaError(violations)
  }

  const label = (path: string): string => (path === '' ? 'arguments' : path)
  const join = (path: string, key: string): string =>
    path === '' ? key : `${path}.${key}`

  const checkValue = (
    node: JsonSchemaNode,
    value: unknown,
    path: string,
  ): string[] => {
    try {
      if (node.oneOf !== undefined) {
        let matches = 0
        for (const branch of node.oneOf) {
          if (checkValue(branch, value, path).length === 0) matches++
        }
        return matches === 1
          ? []
          : [
              `"${label(path)}" must match exactly one oneOf branch (matched ${matches})`,
            ]
      }
      const scalar = (): string[] => {
        if (node.enum !== undefined && !node.enum.includes(value as never))
          return [
            `"${label(path)}" must be one of ${JSON.stringify(node.enum)}`,
          ]
        if (has(node, 'const') && value !== node.const)
          return [`"${label(path)}" must be ${JSON.stringify(node.const)}`]
        return []
      }
      switch (node.type) {
        case undefined:
          return safeIsJson(value)
            ? []
            : [`"${label(path)}" must be a lossless JSON value`]
        case 'object': {
          if (!isRecord(value)) return [`"${label(path)}" must be an object`]
          const properties = node.properties ?? {}
          const violations: string[] = []
          for (const key of node.required ?? []) {
            if (!has(value, key) || value[key] === undefined)
              violations.push(`missing required property "${join(path, key)}"`)
          }
          for (const [key, child] of Object.entries(properties)) {
            if (!has(value, key) || value[key] === undefined) continue
            violations.push(...checkValue(child, value[key], join(path, key)))
          }
          if (node.additionalProperties === false) {
            for (const key of Object.keys(value)) {
              if (!has(properties, key))
                violations.push(
                  `"${join(path, key)}" is not a declared property (additionalProperties: false)`,
                )
            }
          }
          if (violations.length > 0) return violations
          return safeIsJson(value)
            ? []
            : [`"${label(path)}" must be a lossless JSON object`]
        }
        case 'array': {
          if (!Array.isArray(value))
            return [`"${label(path)}" must be an array`]
          const violations: string[] = []
          if (node.items !== undefined) {
            const items = node.items
            value.forEach((entry, index) => {
              violations.push(...checkValue(items, entry, `${path}[${index}]`))
            })
          }
          if (violations.length > 0) return violations
          return safeIsJson(value)
            ? []
            : [`"${label(path)}" must be a dense lossless JSON array`]
        }
        case 'string':
          return typeof value === 'string'
            ? scalar()
            : [`"${label(path)}" must be a string`]
        case 'number':
          if (typeof value !== 'number')
            return [`"${label(path)}" must be a number`]
          return isJsonNumber(value)
            ? scalar()
            : [`"${label(path)}" must be a finite JSON number`]
        case 'integer':
          return isJsonNumber(value) && Number.isInteger(value)
            ? scalar()
            : [`"${label(path)}" must be an integer`]
        case 'boolean':
          return typeof value === 'boolean'
            ? scalar()
            : [`"${label(path)}" must be a boolean`]
        case 'null':
          return value === null ? scalar() : [`"${label(path)}" must be null`]
        default:
          return [`"${label(path)}" has an unsupported schema type`]
      }
    } catch {
      return [`"${label(path)}" must be a lossless JSON value`]
    }
  }

  return {
    JsonSchemaError,
    assertSupportedJsonSchema,
    assertObjectJsonSchema,
    validateJsonSchemaValue: (schema, value, path = 'value') =>
      checkValue(schema, value, path),
  }
}

/** The host-side kit instance. */
export const jsonSchema: JsonSchemaKit = createJsonSchemaKit()
