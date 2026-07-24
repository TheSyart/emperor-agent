import { describe, expect, it, vi } from 'vitest'
import { TerminalService, type PtyHandle, type PtyHost } from './terminal'

class FakePtyHost implements PtyHost {
  handles: PtyHandle[] = []

  spawn(): PtyHandle {
    let onData: (data: string) => void = () => undefined
    let onExit: (event: { exitCode: number; signal?: number }) => void = () =>
      undefined
    const handle: PtyHandle = {
      pid: 42,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData(listener) {
        onData = listener
        return () => undefined
      },
      onExit(listener) {
        onExit = listener
        return () => undefined
      },
      emitData(data) {
        onData(data)
      },
      emitExit(event) {
        onExit(event)
      },
    }
    this.handles.push(handle)
    return handle
  }
}

describe('TerminalService', () => {
  it('owns PTYs by session and preserves ordered in-memory output', () => {
    const host = new FakePtyHost()
    const events: unknown[] = []
    const service = new TerminalService({
      host,
      resolveProject: (sessionId) => ({
        sessionId,
        projectRoot: '/workspace/project',
      }),
      shell: () => ({ executable: '/bin/zsh', args: [] }),
      env: () => ({ PATH: '/usr/bin' }),
      emit: (event) => events.push(event),
    })

    const terminal = service.create({ sessionId: 's1', cols: 100, rows: 30 })
    host.handles[0]?.emitData?.('hello')
    host.handles[0]?.emitData?.(' world')

    expect(
      service.read({ sessionId: 's1', terminalId: terminal.id, afterSeq: 0 }),
    ).toMatchObject({
      chunks: [
        { seq: 1, data: 'hello' },
        { seq: 2, data: ' world' },
      ],
    })
    expect(events).toHaveLength(2)
    expect(() =>
      service.read({ sessionId: 's2', terminalId: terminal.id, afterSeq: 0 }),
    ).toThrowError(expect.objectContaining({ code: 'terminal_owner_invalid' }))
  })

  it('writes, resizes and closes only the owning terminal', () => {
    const host = new FakePtyHost()
    const service = new TerminalService({
      host,
      resolveProject: (sessionId) => ({ sessionId, projectRoot: '/project' }),
      shell: () => ({ executable: '/bin/zsh', args: [] }),
      env: () => ({}),
    })
    const terminal = service.create({ sessionId: 's1', cols: 80, rows: 24 })

    service.write({ sessionId: 's1', terminalId: terminal.id, data: 'pwd\r' })
    service.resize({
      sessionId: 's1',
      terminalId: terminal.id,
      cols: 120,
      rows: 40,
    })
    service.close({ sessionId: 's1', terminalId: terminal.id })

    expect(host.handles[0]?.write).toHaveBeenCalledWith('pwd\r')
    expect(host.handles[0]?.resize).toHaveBeenCalledWith(120, 40)
    expect(host.handles[0]?.kill).toHaveBeenCalledTimes(1)
    expect(service.list({ sessionId: 's1' })).toEqual([])
  })

  it('caps each session at eight terminal tabs, including exited tabs', () => {
    const host = new FakePtyHost()
    const service = new TerminalService({
      host,
      resolveProject: (sessionId) => ({ sessionId, projectRoot: '/project' }),
      shell: () => ({ executable: '/bin/zsh', args: [] }),
      env: () => ({}),
    })
    for (let index = 0; index < 8; index += 1)
      service.create({ sessionId: 's1', cols: 80, rows: 24 })
    host.handles[0]?.emitExit?.({ exitCode: 0 })

    expect(() =>
      service.create({ sessionId: 's1', cols: 80, rows: 24 }),
    ).toThrowError(
      expect.objectContaining({ code: 'terminal_capacity_reached' }),
    )
  })

  it('captures output emitted while PTY subscriptions are attached', () => {
    const host: PtyHost = {
      spawn: () => ({
        pid: 7,
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        onData(listener) {
          listener('ready')
          return () => undefined
        },
        onExit: () => () => undefined,
      }),
    }
    const service = new TerminalService({
      host,
      resolveProject: (sessionId) => ({ sessionId, projectRoot: '/project' }),
      shell: () => ({ executable: '/bin/zsh', args: [] }),
      env: () => ({}),
    })

    const created = service.create({ sessionId: 's1', cols: 80, rows: 24 })

    expect(
      service.read({ sessionId: 's1', terminalId: created.id, afterSeq: 0 }),
    ).toMatchObject({ chunks: [{ seq: 1, data: 'ready' }], latestSeq: 1 })
  })

  it('splits oversized chunks and keeps a strict UTF-8 buffer bound', () => {
    const host = new FakePtyHost()
    const service = new TerminalService({
      host,
      resolveProject: (sessionId) => ({ sessionId, projectRoot: '/project' }),
      shell: () => ({ executable: '/bin/zsh', args: [] }),
      env: () => ({}),
      maxBufferedBytes: 8,
    })
    const created = service.create({ sessionId: 's1', cols: 80, rows: 24 })

    host.handles[0]?.emitData?.('甲乙丙丁戊')
    const replay = service.read({
      sessionId: 's1',
      terminalId: created.id,
      afterSeq: 0,
    })

    expect(
      replay.chunks.reduce(
        (bytes, chunk) => bytes + Buffer.byteLength(chunk.data),
        0,
      ),
    ).toBeLessThanOrEqual(8)
    expect(replay.chunks.map((chunk) => chunk.data).join('')).toBe('丁戊')
  })
})
