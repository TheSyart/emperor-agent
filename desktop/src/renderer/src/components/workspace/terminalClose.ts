/**
 * Closing a terminal tab whose program is still running (a dev server, a
 * long build) ends it, so it asks first (FIX-01). Core reports `busy` when
 * something other than the shell is in the foreground. A list that cannot
 * be read never blocks closing.
 */
import { confirm } from '../ui/confirm'

export async function confirmTerminalClose(
  terminalId: string,
  list: () => Promise<Array<{ id: string; busy?: boolean }>>,
): Promise<boolean> {
  let busy = false
  try {
    busy = Boolean((await list()).find((item) => item.id === terminalId)?.busy)
  } catch {
    return true
  }
  if (!busy) return true
  return await confirm({
    title: '关闭这个终端？',
    body: '终端里还有正在运行的进程，关闭会终止它。',
    confirmLabel: '关闭',
    tone: 'danger',
  })
}
