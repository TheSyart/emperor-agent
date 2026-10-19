// FIX-01: closing a terminal tab whose program is still running asks first.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { answerConfirmsForTest } from '../ui/confirm'
import { confirmTerminalClose } from './terminalClose'

afterEach(() => answerConfirmsForTest(null))

const listed = (busy: boolean) => async () => [
  { id: 't1', busy },
  { id: 't2', busy: false },
]

describe('confirmTerminalClose', () => {
  it('asks before closing a terminal with a running program (4)', async () => {
    const responder = vi.fn((): boolean => false)
    answerConfirmsForTest(responder)
    await expect(confirmTerminalClose('t1', listed(true))).resolves.toBe(false)
    expect(responder).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('正在运行的进程'),
        tone: 'danger',
      }),
    )
    responder.mockReturnValue(true)
    await expect(confirmTerminalClose('t1', listed(true))).resolves.toBe(true)
  })

  it('closes an idle terminal without asking', async () => {
    const responder = vi.fn((): boolean => false)
    answerConfirmsForTest(responder)
    await expect(confirmTerminalClose('t1', listed(false))).resolves.toBe(true)
    expect(responder).not.toHaveBeenCalled()
  })

  it('does not block closing when the list cannot be read', async () => {
    const responder = vi.fn((): boolean => false)
    answerConfirmsForTest(responder)
    await expect(
      confirmTerminalClose('t1', async () => {
        throw new Error('ipc down')
      }),
    ).resolves.toBe(true)
    expect(responder).not.toHaveBeenCalled()
  })
})
