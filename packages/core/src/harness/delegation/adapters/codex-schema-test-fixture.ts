/**
 * A recorded Codex protocol (`protocol/codex-<version>/`) for the adapter's
 * contract tests (AGT-13): JSON Schema validation of what the adapter sends,
 * and lookups of the fields it reads. It covers the keywords Codex's
 * generated schema uses — local `$ref`, `type`, `enum`, `properties`,
 * `required`, `additionalProperties`, `items`, `anyOf`, `oneOf`, `allOf`,
 * `minimum`, `minLength`; `format`, `default` and the annotations are
 * ignored. Test code only.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type Schema = Record<string, unknown>

export const PROTOCOL_ROOT = join(__dirname, '..', 'protocol')

export interface RecordedProtocol {
  version: string
  /** A schema file of this protocol, parsed. */
  file(name: string): Schema
  /**
   * Violations of `value` against the `params` of the ClientRequest variant
   * for `method`; one violation when the protocol has no such method.
   */
  requestViolations(method: string, params: unknown): string[]
  /** Violations of `value` against a whole schema file. */
  violations(file: string, value: unknown): string[]
  /**
   * The schema at a property path of a file, through `$ref`, nullable
   * `anyOf`/`oneOf` and arrays (`[]`); undefined when a step is missing.
   */
  at(file: string, ...path: string[]): Schema | undefined
  /** Methods of ClientRequest.json / ServerRequest.json. */
  methods(file: 'ClientRequest.json' | 'ServerRequest.json'): string[]
}

function resolve(root: Schema, schema: Schema): Schema {
  let current = schema
  for (let depth = 0; typeof current.$ref === 'string' && depth < 64; depth++) {
    const ref = current.$ref as string
    if (!ref.startsWith('#/')) throw new Error('external $ref ' + ref)
    let target: unknown = root
    for (const step of ref.slice(2).split('/'))
      target = (target as Schema | undefined)?.[step]
    if (!target || typeof target !== 'object')
      throw new Error('unresolved $ref ' + ref)
    current = target as Schema
  }
  return current
}

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number')
    return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

function validate(
  root: Schema,
  raw: Schema | boolean,
  value: unknown,
  path: string,
): string[] {
  if (raw === true) return []
  if (raw === false) return [`${path}: not allowed`]
  const schema = resolve(root, raw)
  const out: string[] = []
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    const actual = typeOf(value)
    if (
      !types.includes(actual) &&
      !(actual === 'integer' && types.includes('number'))
    )
      return [`${path}: ${actual} is not ${types.join('|')}`]
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never))
    out.push(`${path}: ${JSON.stringify(value)} is not one of the enum`)
  if (
    typeof schema.minimum === 'number' &&
    typeof value === 'number' &&
    value < schema.minimum
  )
    out.push(`${path}: below ${schema.minimum}`)
  if (
    typeof schema.minLength === 'number' &&
    typeof value === 'string' &&
    value.length < schema.minLength
  )
    out.push(`${path}: shorter than ${schema.minLength}`)
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>
    const properties = (schema.properties ?? {}) as Record<string, Schema>
    for (const key of (schema.required as string[] | undefined) ?? [])
      if (!(key in object)) out.push(`${path}.${key}: required`)
    for (const [key, item] of Object.entries(object)) {
      if (key in properties)
        out.push(...validate(root, properties[key]!, item, `${path}.${key}`))
      else if (schema.additionalProperties !== undefined)
        out.push(
          ...validate(
            root,
            schema.additionalProperties as Schema | boolean,
            item,
            `${path}.${key}`,
          ),
        )
    }
  }
  if (Array.isArray(value) && schema.items && typeof schema.items === 'object')
    value.forEach((item, i) =>
      out.push(
        ...validate(root, schema.items as Schema, item, `${path}[${i}]`),
      ),
    )
  for (const part of (schema.allOf as Schema[] | undefined) ?? [])
    out.push(...validate(root, part, value, path))
  if (Array.isArray(schema.anyOf)) {
    const results = (schema.anyOf as Schema[]).map((part) =>
      validate(root, part, value, path),
    )
    if (!results.some((r) => r.length === 0))
      out.push(`${path}: matches no anyOf branch (${results.flat()[0] ?? ''})`)
  }
  if (Array.isArray(schema.oneOf)) {
    const results = (schema.oneOf as Schema[]).map((part) =>
      validate(root, part, value, path),
    )
    const matches = results.filter((r) => r.length === 0).length
    if (matches !== 1)
      out.push(
        `${path}: matches ${matches} oneOf branches` +
          (matches ? '' : ` (${results.flat()[0] ?? ''})`),
      )
  }
  return out
}

function step(root: Schema, schema: Schema, key: string): Schema | undefined {
  const here = resolve(root, schema)
  if (key === '[]') {
    if (here.items && typeof here.items === 'object')
      return here.items as Schema
  } else {
    const property = (here.properties as Record<string, Schema> | undefined)?.[
      key
    ]
    if (property) return property
  }
  // Nullable or tagged unions: the first branch that has the step.
  for (const branch of [
    ...((here.anyOf as Schema[] | undefined) ?? []),
    ...((here.oneOf as Schema[] | undefined) ?? []),
    ...((here.allOf as Schema[] | undefined) ?? []),
  ]) {
    const found = step(root, branch, key)
    if (found) return found
  }
  return undefined
}

export function recordedProtocol(version: string): RecordedProtocol {
  const folder = join(PROTOCOL_ROOT, 'codex-' + version)
  const cache = new Map<string, Schema>()
  const file = (name: string): Schema => {
    let schema = cache.get(name)
    if (!schema) {
      schema = JSON.parse(readFileSync(join(folder, name), 'utf8')) as Schema
      cache.set(name, schema)
    }
    return schema
  }
  const variants = (name: string) =>
    ((file(name).oneOf as Schema[] | undefined) ?? []).map((variant) => {
      const properties = variant.properties as Record<string, Schema>
      return {
        method: (properties.method!.enum as string[])[0]!,
        params: properties.params,
      }
    })
  return {
    version,
    file,
    methods: (name) => variants(name).map((v) => v.method),
    requestViolations(method, params) {
      const variant = variants('ClientRequest.json').find(
        (v) => v.method === method,
      )
      if (!variant) return [`${method}: not a request of Codex ${version}`]
      if (!variant.params)
        return params === undefined || params === null
          ? []
          : [`${method}: takes no params`]
      return validate(
        file('ClientRequest.json'),
        variant.params,
        params,
        method,
      )
    },
    violations: (name, value) => validate(file(name), file(name), value, name),
    at(name, ...path) {
      const root = file(name)
      let schema: Schema | undefined = root
      for (const key of path) {
        schema = schema && step(root, schema, key)
        if (!schema) return undefined
      }
      return schema && resolve(root, schema)
    },
  }
}
