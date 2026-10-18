import { expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { CodexRpc } from './codex-rpc'
function fixture(
  onRequest?: ConstructorParameters<typeof CodexRpc>[0]['onRequest'],
) {
  const input = new PassThrough(),
    output = new PassThrough()
  const writes: Record<string, unknown>[] = []
  output.on('data', (data) => {
    for (const line of String(data).trim().split('\n'))
      writes.push(JSON.parse(line))
  })
  const rpc = new CodexRpc({
    input,
    output,
    generation: 3,
    onRequest,
    requestTimeoutMs: 1000,
  })
  return {
    input,
    writes,
    rpc,
    receive: (frame: unknown) => input.write(JSON.stringify(frame) + '\n'),
  }
}
it('routes out-of-order responses and keeps server/client IDs separate', async () => {
  const f = fixture()
  const a = f.rpc.request('a', { value: 1 }),
    b = f.rpc.request('b', {})
  await vi.waitFor(() => expect(f.writes.length).toBe(2))
  f.receive({ id: f.writes[1]!.id, result: { value: 2 } })
  f.receive({ id: f.writes[0]!.id, result: { value: 1 } })
  expect(await a).toEqual({ value: 1 })
  expect(await b).toEqual({ value: 2 })
  f.rpc.close()
})
it('delivers duplicate server request once, and cannot answer twice or from stale generation', async () => {
  const handle = vi.fn()
  const f = fixture(handle)
  f.receive({
    id: 7,
    method: 'item/tool/requestUserInput',
    params: { questions: [] },
  })
  f.receive({
    id: 7,
    method: 'item/tool/requestUserInput',
    params: { questions: [] },
  })
  await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce())
  await expect(f.rpc.respond(7, {}, 2)).rejects.toThrow('STALE_RUN')
  await f.rpc.respond(7, { answers: {} }, 3)
  await expect(f.rpc.respond(7, {}, 3)).rejects.toThrow('REQUEST_NOT_FOUND')
  expect(f.writes.filter((w) => w.id === 7).length).toBe(1)
  f.rpc.close()
})
it('rejects unknown server requests with a protocol error instead of approving', async () => {
  const f = fixture()
  f.receive({ id: 'unknown', method: 'future/sideEffect', params: {} })
  await vi.waitFor(() => expect(f.writes.length).toBe(1))
  expect(f.writes[0]).toMatchObject({ id: 'unknown', error: { code: -32601 } })
  f.rpc.close()
})
it('transport end rejects every pending request and never returns an empty success', async () => {
  const f = fixture()
  const a = f.rpc.request('a', {}),
    b = f.rpc.request('b', {})
  const results = Promise.allSettled([a, b])
  f.input.end()
  expect(
    (await results).every(
      (r) =>
        r.status === 'rejected' && String(r.reason).includes('CONNECTION_LOST'),
    ),
  ).toBe(true)
  f.rpc.close()
})
it('invalid JSON closes the transport with a bounded diagnostic', async () => {
  const f = fixture()
  const pending = f.rpc.request('a', {}).catch((e) => e)
  f.input.write('{"secret":"fixture-secret",bad}\n')
  const error = await pending
  expect(String(error)).toContain('PROTOCOL_INVALID')
  expect(String(error)).not.toContain('fixture-secret')
  f.rpc.close()
})

function idleFixture() {
  const input = new PassThrough(),
    output = new PassThrough()
  const writes: Record<string, unknown>[] = []
  output.on('data', (data) => {
    for (const line of String(data).trim().split('\n'))
      writes.push(JSON.parse(line))
  })
  let closed: Error | undefined
  const rpc = new CodexRpc({
    input,
    output,
    generation: 1,
    onRequest: () => undefined,
    onClose: (error) => {
      closed = error
    },
  })
  return {
    rpc,
    writes,
    closed: () => closed,
    receive: (frame: unknown) => input.write(JSON.stringify(frame) + '\n'),
  }
}
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await new Promise((resolve) => setImmediate(resolve))
}

it('stays open while a question waits three minutes for the user, then idles normally', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const f = idleFixture()
    f.receive({
      id: 9,
      method: 'item/tool/requestUserInput',
      params: { questions: [{ id: 'q', question: 'Which?' }] },
    })
    await flush()
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    expect(f.closed()).toBeUndefined()
    await f.rpc.respond(9, { answers: {} }, 1)
    await vi.advanceTimersByTimeAsync(119_000)
    expect(f.closed()).toBeUndefined()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(String(f.closed())).toContain('IDLE_TIMEOUT')
  } finally {
    vi.useRealTimers()
  }
})

it('a running turn holds the idle timer: a silent five-minute command is not killed', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const f = idleFixture()
    const release = f.rpc.hold()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(f.closed()).toBeUndefined()
    release()
    release()
    await vi.advanceTimersByTimeAsync(121_000)
    expect(String(f.closed())).toContain('IDLE_TIMEOUT')
  } finally {
    vi.useRealTimers()
  }
})

it('rejects a result larger than the caller page limit without closing the transport', async () => {
  const f = fixture()
  const page = f.rpc.request('thread/turns/list', {}, undefined, {
    maxResultBytes: 1024,
  })
  await vi.waitFor(() => expect(f.writes.length).toBe(1))
  f.receive({ id: f.writes[0]!.id, result: { data: ['x'.repeat(4096)] } })
  await expect(page).rejects.toThrow('OUTPUT_LIMIT')
  const next = f.rpc.request('thread/turns/list', {}, undefined, {
    maxResultBytes: 1024,
  })
  await vi.waitFor(() => expect(f.writes.length).toBe(2))
  f.receive({ id: f.writes[1]!.id, result: { data: [] } })
  expect(await next).toEqual({ data: [] })
  f.rpc.close()
})
