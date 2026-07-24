import * as nodePty from 'node-pty'
import type { PtyHandle, PtyHost } from '@emperor/core'

export class NodePtyHost implements PtyHost {
  spawn(input: {
    executable: string
    args: string[]
    cwd: string
    env: Record<string, string>
    cols: number
    rows: number
  }): PtyHandle {
    const process = nodePty.spawn(input.executable, input.args, {
      name: 'xterm-256color',
      cols: input.cols,
      rows: input.rows,
      cwd: input.cwd,
      env: input.env,
      encoding: 'utf8',
    })
    return {
      pid: process.pid,
      write: (data) => process.write(data),
      resize: (cols, rows) => process.resize(cols, rows),
      kill: () => process.kill(),
      onData: (listener) => {
        const subscription = process.onData(listener)
        return () => subscription.dispose()
      },
      onExit: (listener) => {
        const subscription = process.onExit(listener)
        return () => subscription.dispose()
      },
    }
  }
}
