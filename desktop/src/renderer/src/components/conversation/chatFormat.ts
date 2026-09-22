// Display formatting shared by the chat rows (dsh message-chrome.ts).

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** `14:05` today, `9月21日 14:05` this year, else `2025/9/21 14:05`. */
export function formatClock(time: number, now = Date.now()): string {
  const date = new Date(time)
  const today = new Date(now)
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (date.toDateString() === today.toDateString()) return clock
  if (date.getFullYear() === today.getFullYear())
    return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${clock}`
}

/** Run duration: `8s`, `2m 05s`, `1h 02m`. */
export function formatRunDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${pad(seconds % 60)}s`
  return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`
}

/** Latency in seconds with one decimal (`0.8s`). */
export function formatLatency(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`
}

/** Decode throughput (`34 tok/s`, `8.5 tok/s`). */
export function formatTokensPerSecond(tps: number): string {
  const rounded = tps >= 10 ? Math.round(tps) : Math.round(tps * 10) / 10
  return `${rounded} tok/s`
}

/** Compact token count: 517 / 12.2K / 1.2M. */
export function formatTokens(n: number): string {
  const scaled = (v: number): string =>
    v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`
  return `${scaled(n / 1_000_000)}M`
}

/** USD from nano-dollars (`$0.42`). */
export function formatUsdNanos(nanos: number): string {
  const usd = nanos / 1e9
  return `$${usd >= 1 ? usd.toFixed(2) : usd.toPrecision(2)}`
}

/** File size (`12 KB`). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
