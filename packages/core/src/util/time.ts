/**
 * 时间工具。Control/Team 使用秒（float），Scheduler 使用毫秒（int）。
 * 两套口径并存是持久化协议的一部分，调用方不得混用。
 */

/** 当前时间，秒（float）。 */
export function nowTs(): number {
  return Date.now() / 1000
}

/** 当前时间，毫秒（int）。 */
export function nowMs(): number {
  return Date.now()
}
