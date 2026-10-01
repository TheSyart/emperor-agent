import { describe, expect, it } from 'vitest'
import {
  DICTATION_MAX_LINE_BYTES,
  DictationProtocolError,
  LineDecoder,
  encodeRequest,
  parseHelperEvent,
  validDevice,
  validLocale,
} from './protocol'

const session = '3f2a9c1e-0000-4000-8000-000000000001'

describe('dictation helper protocol', () => {
  it('encodes requests as JSON lines the helper accepts', () => {
    expect(encodeRequest({ type: 'hello', protocol: 1 })).toBe(
      '{"type":"hello","protocol":1}\n',
    )
    expect(encodeRequest({ type: 'status' })).toBe('{"type":"status"}\n')
    expect(
      JSON.parse(
        encodeRequest({
          type: 'start',
          session,
          locale: 'zh-CN',
          device: null,
          maxSeconds: 300,
        }),
      ),
    ).toEqual({
      type: 'start',
      session,
      locale: 'zh-CN',
      device: null,
      maxSeconds: 300,
    })
    expect(encodeRequest({ type: 'stop', session })).toBe(
      `{"type":"stop","session":"${session}"}\n`,
    )
  })

  it('refuses to encode what the helper would reject', () => {
    for (const request of [
      { type: 'stop', session: 'short' },
      { type: 'cancel', session: 'has space in it' },
      {
        type: 'start',
        session,
        locale: '../etc',
        device: null,
        maxSeconds: 10,
      },
      { type: 'start', session, locale: null, device: '', maxSeconds: 10 },
      { type: 'start', session, locale: null, device: null, maxSeconds: 0 },
      { type: 'start', session, locale: null, device: null, maxSeconds: 601 },
      { type: 'start', session, locale: null, device: null, maxSeconds: 1.5 },
    ] as const)
      expect(
        () => encodeRequest(request as never),
        JSON.stringify(request),
      ).toThrow(DictationProtocolError)
  })

  it('checks locale and device values the way the helper does', () => {
    for (const ok of ['zh-CN', 'en_US', 'yue-Hant-HK', 'en'])
      expect(validLocale(ok), ok).toBe(true)
    for (const bad of ['', 'e', 'zh-', '../etc', 'zh CN', 'x'.repeat(36), 7])
      expect(validLocale(bad), String(bad)).toBe(false)
    expect(validDevice('BuiltInMicrophoneDevice')).toBe(true)
    expect(validDevice('')).toBe(false)
    expect(validDevice('x'.repeat(257))).toBe(false)
  })

  it('parses every helper event', () => {
    expect(
      parseHelperEvent('{"engine":"sf-speech","protocol":1,"type":"hello"}'),
    ).toEqual({ type: 'hello', protocol: 1, engine: 'sf-speech' })
    expect(
      parseHelperEvent(
        JSON.stringify({
          type: 'status',
          permissions: { microphone: 'granted', speech: 'undetermined' },
          devices: [{ id: 'mic-1', name: '内建麦克风', default: true }],
          locales: [{ id: 'zh-CN', name: '中文（中国大陆）' }],
          systemLocale: 'en-US-u-mu-celsius',
          engine: 'sf-speech',
        }),
      ),
    ).toEqual({
      type: 'status',
      permissions: { microphone: 'granted', speech: 'undetermined' },
      devices: [{ id: 'mic-1', name: '内建麦克风', default: true }],
      locales: [{ id: 'zh-CN', name: '中文（中国大陆）' }],
      systemLocale: 'en-US-u-mu-celsius',
      engine: 'sf-speech',
    })
    expect(
      parseHelperEvent(
        `{"locale":"zh-CN","seq":1,"session":"${session}","type":"started"}`,
      ),
    ).toEqual({ type: 'started', session, seq: 1, locale: 'zh-CN' })
    expect(
      parseHelperEvent(
        `{"seq":2,"session":"${session}","text":"你好","type":"partial"}`,
      ),
    ).toEqual({ type: 'partial', session, seq: 2, text: '你好' })
    expect(
      parseHelperEvent(
        `{"seq":3,"session":"${session}","text":"你好。","type":"final"}`,
      ),
    ).toEqual({ type: 'final', session, seq: 3, text: '你好。' })
    expect(
      parseHelperEvent(
        `{"reason":"max_duration","seq":4,"session":"${session}","type":"ended"}`,
      ),
    ).toEqual({ type: 'ended', session, seq: 4, reason: 'max_duration' })
    expect(
      parseHelperEvent(
        '{"code":"invalid_request","message":"bad","seq":null,"session":null,"type":"error"}',
      ),
    ).toEqual({
      type: 'error',
      session: null,
      seq: null,
      code: 'invalid_request',
      message: 'bad',
    })
  })

  it('parses the loudness the helper sends while listening (RV-06)', () => {
    expect(
      parseHelperEvent(
        `{"seq":5,"session":"${session}","type":"level","value":0.43}`,
      ),
    ).toEqual({ type: 'level', session, seq: 5, value: 0.43 })
    for (const value of [0, 1])
      expect(
        parseHelperEvent(
          JSON.stringify({ type: 'level', session, seq: 6, value }),
        ),
      ).toMatchObject({ value })
    for (const value of ['0.5', null, -0.01, 1.01, true])
      expect(
        () =>
          parseHelperEvent(
            JSON.stringify({ type: 'level', session, seq: 7, value }),
          ),
        String(value),
      ).toThrow(DictationProtocolError)
    expect(() =>
      parseHelperEvent(`{"type":"level","session":"${session}","seq":8}`),
    ).toThrow(DictationProtocolError)
  })

  it('rejects anything else the helper might print', () => {
    for (const line of [
      'not json',
      '[]',
      '{"type":"launch"}',
      '{"type":"hello","protocol":"1","engine":"x"}',
      `{"type":"partial","session":"${session}","seq":0,"text":"x"}`,
      `{"type":"partial","session":"${session}","seq":1.5,"text":"x"}`,
      `{"type":"partial","session":"short","seq":1,"text":"x"}`,
      `{"type":"final","session":"${session}","seq":1}`,
      `{"type":"ended","session":"${session}","seq":2,"reason":"done"}`,
      '{"type":"error","session":null,"seq":null,"code":"oops","message":"x"}',
      '{"type":"status","permissions":{"microphone":"yes","speech":"granted"},"devices":[],"locales":[],"systemLocale":"en-US","engine":"x"}',
      '{"type":"status","permissions":{"microphone":"granted","speech":"granted"},"devices":[{"id":"","name":"x","default":true}],"locales":[],"systemLocale":"en-US","engine":"x"}',
    ])
      expect(() => parseHelperEvent(line), line).toThrow(DictationProtocolError)
  })

  it('splits lines across chunks, including split UTF-8 characters', () => {
    const decoder = new LineDecoder()
    const bytes = Buffer.from('{"a":"你"}\n{"b":1}\n{"c"')
    expect(decoder.push(bytes.subarray(0, 8))).toEqual([])
    expect(decoder.push(bytes.subarray(8))).toEqual(['{"a":"你"}', '{"b":1}'])
    expect(decoder.push(Buffer.from(':2}\n\n'))).toEqual(['{"c":2}'])
  })

  it('gives up on a line longer than the limit', () => {
    const decoder = new LineDecoder()
    expect(() =>
      decoder.push(Buffer.alloc(DICTATION_MAX_LINE_BYTES + 1, 0x61)),
    ).toThrow(DictationProtocolError)
  })
})
