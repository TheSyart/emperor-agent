/**
 * UTC+8 ISO 时间戳 (memory 层用)。
 * 输出形如 2026-06-26T14:28:01+08:00。
 */
export function nowIsoUtc8(epochMs: number = Date.now()): string {
  const shifted = new Date(epochMs + 8 * 3600 * 1000)
  const y = shifted.getUTCFullYear()
  const mo = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const d = String(shifted.getUTCDate()).padStart(2, '0')
  const h = String(shifted.getUTCHours()).padStart(2, '0')
  const mi = String(shifted.getUTCMinutes()).padStart(2, '0')
  const s = String(shifted.getUTCSeconds()).padStart(2, '0')
  return `${y}-${mo}-${d}T${h}:${mi}:${s}+08:00`
}

export function todayUtc8(epochMs: number = Date.now()): string {
  return nowIsoUtc8(epochMs).slice(0, 10)
}
