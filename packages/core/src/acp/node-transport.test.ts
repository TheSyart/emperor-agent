import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createBoundedNodeAcpStream } from './node-transport'

describe('bounded ACP Node transport', () => {
  it('parses split and multiple NDJSON messages without reordering', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const stream = createBoundedNodeAcpStream(input, output, {
      maxLineBytes: 1024,
    })
    const reader = stream.readable.getReader()

    input.write('{"jsonrpc":"2.0","id":1,"method":"init')
    input.write('ialize","params":{}}\n{"jsonrpc":"2.0","method":"x"}\n')

    await expect(reader.read()).resolves.toMatchObject({
      done: false,
      value: { id: 1, method: 'initialize' },
    })
    await expect(reader.read()).resolves.toMatchObject({
      done: false,
      value: { method: 'x' },
    })

    input.end()
    await expect(reader.read()).resolves.toEqual({ done: true })
  })

  it('rejects an oversized unterminated line before unbounded accumulation', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const stream = createBoundedNodeAcpStream(input, output, {
      maxLineBytes: 64,
    })
    const reader = stream.readable.getReader()

    input.write('x'.repeat(65))

    await expect(reader.read()).rejects.toThrow('ACP line exceeds 64 bytes')
  })

  it('rejects invalid JSON and non-object messages', async () => {
    for (const line of ['{bad json}\n', '[]\n']) {
      const input = new PassThrough()
      const output = new PassThrough()
      const reader = createBoundedNodeAcpStream(input, output).readable.getReader()
      input.end(line)
      await expect(reader.read()).rejects.toThrow(/invalid ACP JSON|ACP message must be an object/)
    }
  })

  it('awaits Node writer callbacks and propagates broken-pipe errors', async () => {
    const input = new PassThrough()
    let callback: ((error?: Error | null) => void) | null = null
    const output = new Writable({
      write(_chunk, _encoding, done) {
        callback = done
      },
    })
    const writer = createBoundedNodeAcpStream(input, output).writable.getWriter()
    let settled = false
    const pending = writer
      .write({ jsonrpc: '2.0', id: 1, result: {} })
      .finally(() => {
        settled = true
      })

    await Promise.resolve()
    expect(settled).toBe(false)
    expect(callback).not.toBeNull()
    callback!(new Error('broken pipe'))
    await expect(pending).rejects.toThrow('broken pipe')
  })
})
