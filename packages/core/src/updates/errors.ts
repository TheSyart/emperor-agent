import { EmperorError } from '../errors'

/**
 * Update check and download failures (REL-02). The message is Chinese and
 * says what happened and what Emperor did about it; the code stays stable
 * for the renderer (errors/messages.ts has a fallback for each).
 */
export class UpdateError extends EmperorError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, code, options)
  }
}

export function updateErrorOf(error: unknown): UpdateError {
  if (error instanceof UpdateError) return error
  const detail = error instanceof Error ? error.message : String(error)
  return new UpdateError(
    'update_network_failed',
    `连接 GitHub 失败：${detail || '未知原因'}`,
    { cause: error },
  )
}
