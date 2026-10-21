/** The line written into a terminal when its process ends (UI-S10). */
export function terminalExitLine(exitCode: number | null | undefined): string {
  return exitCode === null || exitCode === undefined
    ? '\r\n[进程已退出：被信号终止]'
    : `\r\n[进程已退出，退出码 ${exitCode}]`
}
