import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { DictationEvent } from '../../shared/ipc-contract'
import { DictationService } from './dictation-service'

// A stand-in helper on real pipes: the same JSON lines as the Swift one.
// The partial result is written in two pieces to exercise line framing.
const FAKE_HELPER = String.raw`
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
let seq = 0
const send = (event) => process.stdout.write(JSON.stringify(event) + '\n')
input.on('line', (line) => {
  const request = JSON.parse(line)
  const session = request.session
  switch (request.type) {
    case 'hello':
      return send({ type: 'hello', protocol: 1, engine: 'fake' })
    case 'status':
      return send({
        type: 'status',
        permissions: { microphone: 'granted', speech: 'undetermined' },
        devices: [{ id: 'mic-1', name: 'Mic', default: true }],
        locales: [{ id: 'zh-CN', name: '中文' }],
        systemLocale: 'zh-CN',
        engine: 'fake',
      })
    case 'start': {
      if (request.locale === 'xx-XX') process.exit(3)
      seq = 0
      send({ type: 'started', session, seq: ++seq, locale: 'zh-CN' })
      const bytes = Buffer.from(
        JSON.stringify({ type: 'partial', session, seq: ++seq, text: '你好' }) + '\n',
      )
      process.stdout.write(bytes.subarray(0, 50))
      setTimeout(() => process.stdout.write(bytes.subarray(50)), 20)
      return
    }
    case 'stop':
      send({ type: 'final', session, seq: ++seq, text: '你好。' })
      return send({ type: 'ended', session, seq: ++seq, reason: 'stopped' })
    case 'cancel':
      return send({ type: 'ended', session, seq: ++seq, reason: 'cancelled' })
  }
})
input.on('close', () => process.exit(0))
`

const root = mkdtempSync(join(tmpdir(), 'emperor-dictation-'))
const script = join(root, 'fake-helper.cjs')
const executable = join(root, 'emperor-dictation-helper')
writeFileSync(script, FAKE_HELPER)
writeFileSync(
  executable,
  `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)}\n`,
)
chmodSync(executable, 0o755)

afterAll(() => rmSync(root, { recursive: true, force: true }))

function recorder() {
  const events: DictationEvent[] = []
  return {
    events,
    listener: {
      deliver: (event: DictationEvent) => {
        events.push(event)
        return true
      },
    },
  }
}

describe('dictation helper process', () => {
  it('talks to a real child process over stdin and stdout', async () => {
    const service = new DictationService({
      platform: 'darwin',
      executable: () => executable,
      env: { PATH: process.env.PATH ?? '' },
    })
    try {
      expect(await service.status()).toMatchObject({
        available: true,
        engine: 'fake',
        permissions: { microphone: 'granted', speech: 'undetermined' },
      })
      const { events, listener } = recorder()
      const result = await service.start({ locale: 'zh-CN' }, listener)
      expect(result.ok).toBe(true)
      await vi.waitFor(() => expect(events).toHaveLength(2))
      expect(events[1]).toMatchObject({ type: 'partial', text: '你好' })
      service.stop((result as { session: string }).session)
      await vi.waitFor(() => expect(events).toHaveLength(4))
      expect(events.map((event) => event.type)).toEqual([
        'started',
        'partial',
        'final',
        'ended',
      ])
    } finally {
      service.dispose()
    }
  })

  it('notices the child dying in the middle of a dictation', async () => {
    const service = new DictationService({
      platform: 'darwin',
      executable: () => executable,
      env: { PATH: process.env.PATH ?? '' },
    })
    try {
      const { events, listener } = recorder()
      expect((await service.start({ locale: 'xx-XX' }, listener)).ok).toBe(true)
      await vi.waitFor(() => expect(events).toHaveLength(2))
      expect(events).toMatchObject([
        { type: 'error', code: 'helper_exited', seq: 1 },
        { type: 'ended', reason: 'error', seq: 2 },
      ])
    } finally {
      service.dispose()
    }
  })

  it('reports a helper that cannot be started', async () => {
    const service = new DictationService({
      platform: 'darwin',
      executable: () => join(root, 'missing-helper'),
    })
    const status = await service.status()
    expect(status.available).toBe(false)
    expect(status.reason).toMatch(/Emperor Dictation Helper/)
  })
})
