import { randomUUID } from 'node:crypto'
import { ValidationError } from '../errors'

/**
 * id 工具。
 *
 * 生成“前缀 + 截断的 UUID hex”。前缀与长度保持，
 * 便于磁盘可读（非格式契约）。
 */

/** 生成 `${prefix}${hex[:len]}`。默认 12 位 hex。 */
export function newId(prefix: string, len = 12): string {
  const hex = randomUUID().replace(/-/g, '')
  return `${prefix}${hex.slice(0, len)}`
}

/**
 * 通用名称/id 校验原语。各子系统（scheduler `validate_job_id`、team
 * `validate_member_name`/`validate_actor_name`）在各自波次用它实例化具体规则。
 */
export function validateName(
  value: string,
  opts: { pattern: RegExp; maxLen: number; label: string },
): string {
  const v = (value ?? '').trim()
  if (!v) throw new ValidationError(`${opts.label} must not be empty`)
  if (v.length > opts.maxLen) {
    throw new ValidationError(`${opts.label} too long (>${opts.maxLen})`)
  }
  if (!opts.pattern.test(v)) {
    throw new ValidationError(`${opts.label} has invalid characters: ${value}`)
  }
  return v
}
