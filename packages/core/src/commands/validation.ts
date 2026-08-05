import type { ParsedCommandInput } from './parser'
import type { CommandDescriptor } from './types'

export interface ValidatedCommandArguments {
  positional: Record<string, string | string[] | undefined>
  options: Record<string, string | boolean>
}

export class CommandValidationError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'CommandValidationError'
    this.code = code
  }
}

export function validateCommandArguments(
  descriptor: CommandDescriptor,
  parsed: ParsedCommandInput,
): ValidatedCommandArguments {
  const specs = descriptor.argumentSchema
  const positionalSpecs = specs.filter((item) => item.positional !== false)
  const optionSpecs = new Map(
    specs
      .filter((item) => item.positional === false)
      .map((item) => [item.name, item]),
  )
  const positional: Record<string, string | string[] | undefined> = {}
  let cursor = 0
  for (const spec of positionalSpecs) {
    if (spec.variadic) {
      const value = parsed.args.slice(cursor)
      positional[spec.name] = value
      cursor = parsed.args.length
      if (spec.required && !value.length)
        throw new CommandValidationError(
          'missing_argument',
          `缺少参数：${spec.name}`,
        )
      continue
    }
    const value = parsed.args[cursor]
    if (value !== undefined) cursor += 1
    if (spec.required && value === undefined)
      throw new CommandValidationError(
        'missing_argument',
        `缺少参数：${spec.name}`,
      )
    if (value !== undefined) validateValue(spec, value)
    positional[spec.name] = value
  }
  if (cursor < parsed.args.length)
    throw new CommandValidationError('too_many_arguments', '命令参数过多。')

  for (const [name, value] of Object.entries(parsed.options)) {
    const spec = optionSpecs.get(name)
    if (!spec)
      throw new CommandValidationError('unknown_option', `未知选项：--${name}`)
    if (spec.type === 'boolean' && typeof value !== 'boolean')
      throw new CommandValidationError('invalid_option', `--${name} 不接受值。`)
    if (typeof value === 'string') validateValue(spec, value)
  }
  for (const spec of optionSpecs.values()) {
    if (spec.required && parsed.options[spec.name] === undefined)
      throw new CommandValidationError(
        'missing_option',
        `缺少选项：--${spec.name}`,
      )
  }
  return { positional, options: { ...parsed.options } }
}

function validateValue(
  spec: CommandDescriptor['argumentSchema'][number],
  value: string,
): void {
  if (value.includes('\0'))
    throw new CommandValidationError(
      'invalid_argument',
      `${spec.name} 包含非法字符。`,
    )
  if (
    spec.type === 'enum' &&
    !(spec.values ?? []).includes(value.toLowerCase())
  )
    throw new CommandValidationError(
      'invalid_argument',
      `${spec.name} 必须是 ${(spec.values ?? []).join('、')} 之一。`,
    )
  if (spec.type === 'id' && !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value))
    throw new CommandValidationError(
      'invalid_argument',
      `${spec.name} 不是有效 ID。`,
    )
  if (
    spec.type === 'relative_path' &&
    (value.startsWith('/') ||
      /^[A-Za-z]:[\\/]/.test(value) ||
      value.split(/[\\/]/).includes('..'))
  )
    throw new CommandValidationError(
      'invalid_argument',
      `${spec.name} 必须是项目内相对路径。`,
    )
}
