import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { UiError } from '../errors'
import {
  encodeBlobFrame,
  encodeJsonFrame,
  FrameDecoder,
  FramingError,
  MAX_FRAME_BYTES,
  MAX_JSON_BYTES,
} from './framing'
import {
  acceptHello,
  HELPER_EVENTS,
  HELPER_METHODS,
  isHelperMethod,
  parseHelperMessage,
} from './messages'
import { helperProtocolJsonSchema } from './schema'

const here = dirname(fileURLToPath(import.meta.url))
const update = process.env.UPDATE_PROTOCOL_FIXTURES === '1'

interface Fixture {
  name: string
  method?: string
  part?: 'params' | 'result'
  event?: string
  message: Record<string, unknown>
}

const fixtures = (
  JSON.parse(readFileSync(resolve(here, 'fixtures/messages.json'), 'utf8')) as {
    messages: Fixture[]
  }
).messages

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

describe('helper protocol messages', () => {
  it.each(fixtures.map((fixture) => [fixture.name, fixture] as const))(
    'golden %s parses',
    (_name, fixture) => {
      const parsed = parseHelperMessage(fixture.message)
      expect(parsed.type).toBe(fixture.message.type)
      if (fixture.method !== undefined) {
        expect(isHelperMethod(fixture.method)).toBe(true)
        const spec =
          HELPER_METHODS[fixture.method as keyof typeof HELPER_METHODS]
        const body =
          fixture.part === 'params'
            ? fixture.message.params
            : fixture.message.result
        expect(() => spec[fixture.part!].parse(body)).not.toThrow()
      }
      if (fixture.event !== undefined) {
        const schema =
          HELPER_EVENTS[fixture.event as keyof typeof HELPER_EVENTS]
        expect(() => schema.parse(fixture.message.data)).not.toThrow()
      }
    },
  )

  it('covers every method and event with at least one fixture or schema entry', () => {
    const schema = helperProtocolJsonSchema()
    expect(Object.keys(schema.methods as object).sort()).toEqual(
      Object.keys(HELPER_METHODS).sort(),
    )
    expect(Object.keys(schema.events as object).sort()).toEqual(
      Object.keys(HELPER_EVENTS).sort(),
    )
  })

  it('rejects unknown fields and message types', () => {
    expect(() =>
      parseHelperMessage({ type: 'ping', seq: 1, extra: true }),
    ).toThrow()
    expect(() => parseHelperMessage({ type: 'exec', command: 'ls' })).toThrow()
    expect(() =>
      HELPER_METHODS.act.params.parse({
        operationId: 'op',
        targetId: 't',
        generation: 1,
        expectedRevision: 1,
        action: { kind: 'evaluate', script: 'alert(1)' },
      }),
    ).toThrow()
  })

  it('enforces the protocol major version at hello', () => {
    const hello = fixtures.find((fixture) => fixture.name === 'hello')!.message
    expect(acceptHello(hello).protocol).toBe(1)
    try {
      acceptHello({ ...hello, protocol: 2 })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(UiError)
      expect((error as UiError).code).toBe('PROTOCOL_MISMATCH')
    }
  })

  it('keeps schema.json in sync with the zod source', () => {
    const path = resolve(here, 'schema.json')
    const generated = `${JSON.stringify(helperProtocolJsonSchema(), null, 2)}\n`
    if (update || !existsSync(path)) writeFileSync(path, generated)
    expect(readFileSync(path, 'utf8')).toBe(generated)
  })

  it('requires a concrete app identity for native secret fill', () => {
    const fill = HELPER_METHODS['act.fillSecret'].params
    const base = {
      operationId: 'op',
      targetId: 'target',
      generation: 1,
      expectedRevision: 1,
      ref: 'r1.1',
      field: 'password',
      secret: 'private',
    }
    expect(fill.safeParse(base).success).toBe(false)
    expect(
      fill.safeParse({ ...base, binding: { bundleId: 'com.example.Writer' } })
        .success,
    ).toBe(false)
    expect(
      fill.safeParse({
        ...base,
        binding: { bundleId: 'com.example.Writer', teamId: 'EXAMPLE123' },
      }).success,
    ).toBe(true)
  })
})

describe('helper protocol framing', () => {
  it('round-trips JSON and blob frames through a byte-by-byte stream', () => {
    const bytes = Uint8Array.from({ length: 300 }, (_, index) => index % 256)
    const stream = new Uint8Array([
      ...encodeJsonFrame({ type: 'ping', seq: 1 }),
      ...encodeBlobFrame('b-1', bytes),
      ...encodeJsonFrame({ type: 'pong', seq: 1 }),
    ])
    const decoder = new FrameDecoder()
    const frames = []
    for (const byte of stream) frames.push(...decoder.push(Uint8Array.of(byte)))
    expect(frames).toEqual([
      { kind: 'json', value: { type: 'ping', seq: 1 } },
      { kind: 'blob', blobId: 'b-1', bytes },
      { kind: 'json', value: { type: 'pong', seq: 1 } },
    ])
    expect(decoder.pending).toBe(0)
  })

  it('decodes several frames delivered in one chunk and keeps a partial tail', () => {
    const one = encodeJsonFrame({ type: 'ping', seq: 2 })
    const two = encodeJsonFrame({ type: 'ping', seq: 3 })
    const decoder = new FrameDecoder()
    const frames = decoder.push(new Uint8Array([...one, ...two.subarray(0, 5)]))
    expect(frames).toHaveLength(1)
    expect(decoder.pending).toBe(5)
    expect(decoder.push(two.subarray(5))).toEqual([
      { kind: 'json', value: { type: 'ping', seq: 3 } },
    ])
  })

  it('refuses oversized JSON on both ends', () => {
    const big = { type: 'event', name: 'x', data: 'a'.repeat(MAX_JSON_BYTES) }
    expect(() => encodeJsonFrame(big)).toThrow(FramingError)

    const body = new Uint8Array(MAX_JSON_BYTES + 2)
    body[0] = 1
    const frame = new Uint8Array(4 + body.byteLength)
    new DataView(frame.buffer).setUint32(0, body.byteLength, false)
    frame.set(body, 4)
    expect(() => new FrameDecoder().push(frame)).toThrow(/exceeds/)
  })

  it('refuses a frame length beyond 32 MiB before buffering it', () => {
    const header = new Uint8Array(5)
    new DataView(header.buffer).setUint32(0, MAX_FRAME_BYTES + 1, false)
    const decoder = new FrameDecoder()
    expect(() => decoder.push(header)).toThrow(/out of range/)
    expect(() => decoder.push(new Uint8Array(1))).toThrow(/already failed/)
  })

  it('rejects unknown kinds, bad UTF-8, and malformed blob ids', () => {
    const frameOf = (kind: number, body: number[]): Uint8Array => {
      const out = new Uint8Array(5 + body.length)
      new DataView(out.buffer).setUint32(0, body.length + 1, false)
      out[4] = kind
      out.set(body, 5)
      return out
    }
    expect(() => new FrameDecoder().push(frameOf(9, [1]))).toThrow(
      /unknown frame kind/,
    )
    expect(() => new FrameDecoder().push(frameOf(1, [0xff, 0xfe]))).toThrow(
      /UTF-8/,
    )
    expect(() =>
      new FrameDecoder().push(frameOf(2, [3, 0x2f, 0x2f, 0x2f])),
    ).toThrow(/malformed blob/)
    expect(() => encodeBlobFrame('../x', new Uint8Array(1))).toThrow(/blob id/)
  })

  it('matches the golden frame bytes shared with native helpers', () => {
    const path = resolve(here, 'fixtures/frames.json')
    const generated = {
      $comment:
        'Golden frame encodings (hex). Native helper tests decode these and must re-encode the same bytes.',
      frames: [
        {
          name: 'json-ping',
          message: { type: 'ping', seq: 7 },
          hex: hex(encodeJsonFrame({ type: 'ping', seq: 7 })),
        },
        {
          name: 'blob-small',
          blobId: 'b-77',
          bytes: [1, 2, 3],
          hex: hex(encodeBlobFrame('b-77', Uint8Array.of(1, 2, 3))),
        },
      ],
    }
    const text = `${JSON.stringify(generated, null, 2)}\n`
    if (update || !existsSync(path)) writeFileSync(path, text)
    expect(readFileSync(path, 'utf8')).toBe(text)
    // u32 length 24 (kind + 23 JSON bytes) · kind 1 · {"type":"ping","seq":7}
    expect(generated.frames[0]!.hex).toBe(
      `0000001801${Buffer.from('{"type":"ping","seq":7}').toString('hex')}`,
    )
  })
})
