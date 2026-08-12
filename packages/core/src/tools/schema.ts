/**
 * 工具参数 schema：StringSchema/IntegerSchema/… + toolParamsSchema。
 */
export interface StringSchema {
  type: 'string'
  description: string
}
export interface IntegerSchema {
  type: 'integer'
  description: string
}
export interface NumberSchema {
  type: 'number'
  description: string
}
export interface BooleanSchema {
  type: 'boolean'
  description: string
}
export interface ArraySchema {
  type: 'array'
  items: ParamSchema
  description: string
}
export interface ObjectSchema {
  type: 'object'
  properties: Record<string, ParamSchema>
  required?: string[]
  description: string
  additionalProperties?: false
}
export interface ScalarUnionSchema {
  type: Array<'string' | 'integer' | 'number' | 'boolean' | 'null'>
  description: string
}
export type ParamSchema =
  | StringSchema
  | IntegerSchema
  | NumberSchema
  | BooleanSchema
  | ArraySchema
  | ObjectSchema
  | ScalarUnionSchema

export interface ToolParamsSchema {
  type: 'object'
  properties: Record<string, ParamSchema>
  required: string[]
  additionalProperties?: false
}

export function S(description: string): StringSchema {
  return { type: 'string', description }
}
export function I(description: string): IntegerSchema {
  return { type: 'integer', description }
}
export function N(description: string): NumberSchema {
  return { type: 'number', description }
}
export function B(description: string): BooleanSchema {
  return { type: 'boolean', description }
}

export function toolParamsSchema(
  fields: Record<string, ParamSchema>,
  required?: string[],
): ToolParamsSchema {
  return { type: 'object', properties: fields, required: required ?? [] }
}
