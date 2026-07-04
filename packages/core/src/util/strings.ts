/** 归一化可选字符串：仅接受真正的 string，trim 后为空或非字符串一律返回 ''。 */
export function cleanString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}
