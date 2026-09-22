import type { StateDotState } from './stateDot'

/** Prompt label for a cwd: `~` for home, else the last path segment. */
export function promptLabel(cwd: string, home: string | undefined): string {
  const trimmed = cwd.replace(/[/\\]+$/, '')
  if (home !== undefined && trimmed === home.replace(/[/\\]+$/, '')) return '~'
  const segment = trimmed.split(/[/\\]/).pop()
  return segment === undefined || segment === '' ? cwd : segment
}

/** Run-state dot + a11y label + optional status pill for a shell command. */
export function terminalStatus(
  running: boolean,
  exitCode: number | undefined,
  signal: string | undefined,
): { dot: StateDotState; label: string; pill?: string } {
  if (running) return { dot: 'ongoing', label: '运行中' }
  if (signal !== undefined)
    return { dot: 'error', label: '失败', pill: `信号 ${signal}` }
  if (exitCode !== undefined && exitCode !== 0)
    return { dot: 'error', label: '失败', pill: `退出码 ${exitCode}` }
  return { dot: 'ok', label: '已完成' }
}
