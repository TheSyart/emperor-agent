// KRN-07: the Files API path for images — cache scope (endpoint + key
// hash), refresh before expiry, cleanup of Emperor's oldest uploads when
// the account is full, the JPEG 85/75/60 ladder, and the back-off.
import { describe, expect, it } from 'vitest'
import type { ImageAttachmentRef } from '../../types'
import { DeepSeekImageFiles, fileScope } from './files'
import { replayTransport, TINY_PNG, type FixtureExchange } from './testing'
import type { ImageTranscoder } from './transcode'

const ORIGIN = 'https://api.deepseek.com'
const FILES_URL = `${ORIGIN}/files`
const MiB = 1024 * 1024
const T0 = 1_760_950_000_000

function uploaded(id: string, createdAtSeconds = T0 / 1000): FixtureExchange {
  return {
    request: { method: 'POST', url: FILES_URL },
    response: {
      status: 200,
      headers: {},
      json: {
        id,
        object: 'file',
        bytes: 67,
        created_at: createdAtSeconds,
        filename: 'emperor-x.png',
        purpose: 'user_data',
        expires_at: createdAtSeconds + 86_400,
      },
    },
  }
}

const dot: ImageAttachmentRef = {
  attachmentId: 'att-dot',
  mediaType: 'image/png',
  bytes: TINY_PNG.byteLength,
  width: 1,
  height: 1,
}

const readDot = async () => ({ data: TINY_PNG, mediaType: 'image/png' })

describe('DeepSeekImageFiles', () => {
  it('keys the cache by endpoint and a hash of the key', async () => {
    const transport = replayTransport([
      uploaded('file-a'),
      uploaded('file-b'),
      uploaded('file-c'),
    ])
    const files = new DeepSeekImageFiles({
      fetch: transport.fetch,
      transcoder: null,
      now: () => T0,
    })
    const source = (apiKey: string, origin = ORIGIN) =>
      files.source({ origin, apiKey, ref: dot, images: readDot })

    expect((await source('sk-one')).source).toEqual({
      type: 'file',
      file_id: 'file-a',
    })
    expect((await source('sk-one')).source).toEqual({
      type: 'file',
      file_id: 'file-a',
    })
    expect((await source('sk-two')).source).toEqual({
      type: 'file',
      file_id: 'file-b',
    })
    expect(transport.calls).toHaveLength(2)

    const scope = fileScope(ORIGIN, 'sk-one')
    expect(scope).toMatch(/^[0-9a-f]{64}$/)
    expect(scope).not.toContain('sk-one')
    expect(fileScope('https://api.deepseek.com/', 'sk-one')).toBe(scope)
    expect(fileScope('https://other.example', 'sk-one')).not.toBe(scope)
  })

  it('uploads again shortly before the file expires', async () => {
    let now = T0
    const transport = replayTransport([uploaded('file-1'), uploaded('file-2')])
    const files = new DeepSeekImageFiles({
      fetch: transport.fetch,
      transcoder: null,
      now: () => now,
    })
    const source = () =>
      files.source({ origin: ORIGIN, apiKey: 'sk', ref: dot, images: readDot })
    expect((await source()).source).toMatchObject({ file_id: 'file-1' })
    now = T0 + 22 * 3_600_000
    expect((await source()).source).toMatchObject({ file_id: 'file-1' })
    now = T0 + 23.5 * 3_600_000
    expect((await source()).source).toMatchObject({ file_id: 'file-2' })
  })

  it('clears the oldest Emperor uploads when the account is full, never anyone else’s, then retries once', async () => {
    const listUrl = `${FILES_URL}?purpose=user_data&order=asc&limit=100`
    const deleted = (id: string): FixtureExchange => ({
      request: { method: 'DELETE', url: `${FILES_URL}/${id}` },
      response: {
        status: 200,
        headers: {},
        json: { id, object: 'file', deleted: true },
      },
    })
    const transport = replayTransport([
      {
        request: { method: 'POST', url: FILES_URL },
        response: {
          status: 400,
          headers: {},
          json: {
            error: {
              message: 'Maximum number of stored files reached (10000)',
              type: 'invalid_request_error',
              code: 'file_quota_exceeded',
            },
          },
        },
      },
      {
        request: { method: 'GET', url: listUrl },
        response: {
          status: 200,
          headers: {},
          json: {
            object: 'list',
            data: [
              {
                id: 'file-user-photo',
                object: 'file',
                bytes: 10,
                created_at: 1,
                filename: 'holiday.jpg',
                purpose: 'user_data',
              },
              {
                id: 'file-emp-old',
                object: 'file',
                bytes: 10,
                created_at: 2,
                filename: 'emperor-0123456789abcdef01234567.png',
                purpose: 'user_data',
              },
              {
                id: 'file-emp-new',
                object: 'file',
                bytes: 10,
                created_at: 3,
                filename: 'emperor-89abcdef0123456789abcdef.jpg',
                purpose: 'user_data',
              },
            ],
            first_id: 'file-user-photo',
            last_id: 'file-emp-new',
            has_more: false,
          },
        },
      },
      deleted('file-emp-old'),
      deleted('file-emp-new'),
      uploaded('file-after-cleanup'),
    ])
    const files = new DeepSeekImageFiles({
      fetch: transport.fetch,
      transcoder: null,
      now: () => T0,
    })
    const result = await files.source({
      origin: ORIGIN,
      apiKey: 'sk',
      ref: dot,
      images: readDot,
    })
    expect(result.source).toEqual({
      type: 'file',
      file_id: 'file-after-cleanup',
    })
    expect(transport.calls.map((call) => `${call.method} ${call.url}`)).toEqual(
      [
        `POST ${FILES_URL}`,
        `GET ${listUrl}`,
        `DELETE ${FILES_URL}/file-emp-old`,
        `DELETE ${FILES_URL}/file-emp-new`,
        `POST ${FILES_URL}`,
      ],
    )
    expect(transport.pending()).toBe(0)
  })

  it('goes inline and backs off when the account stays full', async () => {
    let now = T0
    const quota: FixtureExchange = {
      request: { method: 'POST', url: FILES_URL },
      response: {
        status: 400,
        headers: {},
        json: { error: { message: 'storage quota exceeded' } },
      },
    }
    const transport = replayTransport([
      quota,
      {
        request: {
          method: 'GET',
          url: `${FILES_URL}?purpose=user_data&order=asc&limit=100`,
        },
        response: {
          status: 200,
          headers: {},
          json: { object: 'list', data: [], has_more: false },
        },
      },
      uploaded('file-later'),
    ])
    const files = new DeepSeekImageFiles({
      fetch: transport.fetch,
      transcoder: null,
      now: () => now,
    })
    const source = () =>
      files.source({ origin: ORIGIN, apiKey: 'sk', ref: dot, images: readDot })
    expect((await source()).source).toEqual({
      type: 'base64',
      media_type: 'image/png',
      data: Buffer.from(TINY_PNG).toString('base64'),
    })
    // Within the back-off: inline without asking the Files API again.
    expect((await source()).source.type).toBe('base64')
    expect(transport.calls).toHaveLength(2)
    now = T0 + 11 * 60_000
    expect((await source()).source).toEqual({
      type: 'file',
      file_id: 'file-later',
    })
  })

  it('forgets file ids the endpoint no longer has', async () => {
    const transport = replayTransport([uploaded('file-1'), uploaded('file-2')])
    const files = new DeepSeekImageFiles({
      fetch: transport.fetch,
      transcoder: null,
      now: () => T0,
    })
    const source = () =>
      files.source({ origin: ORIGIN, apiKey: 'sk', ref: dot, images: readDot })
    expect((await source()).fileId).toBe('file-1')
    files.invalidate(ORIGIN, 'sk', ['file-1'])
    expect((await source()).fileId).toBe('file-2')
  })
})

describe('upload variant: JPEG at 85, then 75, then 60', () => {
  const big: ImageAttachmentRef = {
    attachmentId: 'att-big',
    mediaType: 'image/png',
    bytes: 12 * MiB,
    width: 4000,
    height: 3000,
  }
  const readBig = async () => ({
    data: new Uint8Array(12 * MiB),
    mediaType: 'image/png',
  })

  function ladder(sizes: Record<number, number>) {
    const calls: Array<{ quality: number; width: number; height: number }> = []
    const transcoder: ImageTranscoder = {
      async toJpeg(_input, target) {
        calls.push({
          quality: target.quality,
          width: target.width ?? 0,
          height: target.height ?? 0,
        })
        return new Uint8Array(sizes[target.quality] ?? 0)
      },
    }
    return { transcoder, calls }
  }

  async function upload(transcoder: ImageTranscoder | null, ref = big) {
    const transport = replayTransport([uploaded('file-v')])
    const files = new DeepSeekImageFiles({
      fetch: transport.fetch,
      transcoder,
      now: () => T0,
    })
    await files.source({
      origin: ORIGIN,
      apiKey: 'sk',
      ref,
      images: ref === big ? readBig : readDot,
    })
    return transport.calls[0]!.form!.file as {
      filename: string
      type: string
      size: number
    }
  }

  it('scales an image past the pixel budget and keeps the first quality that fits', async () => {
    const { transcoder, calls } = ladder({ 85: 6 * MiB, 75: 4 * MiB, 60: MiB })
    const file = await upload(transcoder)
    expect(calls.map((call) => call.quality)).toEqual([85, 75])
    expect(file).toEqual({
      filename: expect.stringMatching(/^emperor-[0-9a-f]{24}\.jpg$/),
      type: 'image/jpeg',
      size: 4 * MiB,
    })
    const { width, height } = calls[0]!
    expect(width * height).toBeLessThanOrEqual(1300 * 1300)
    expect(width / height).toBeCloseTo(4 / 3, 2)
  })

  it('takes the smallest version when none fits the target', async () => {
    const { transcoder, calls } = ladder({
      85: 9 * MiB,
      75: 8 * MiB,
      60: 7 * MiB,
    })
    const file = await upload(transcoder)
    expect(calls.map((call) => call.quality)).toEqual([85, 75, 60])
    expect(file.size).toBe(7 * MiB)
  })

  it('sends a small image as it is', async () => {
    const { transcoder, calls } = ladder({ 85: 1 })
    const file = await upload(transcoder, dot)
    expect(calls).toEqual([])
    expect(file).toMatchObject({ type: 'image/png', size: TINY_PNG.byteLength })
  })

  it('sends the original when the encoder is missing or fails', async () => {
    expect(await upload(null)).toMatchObject({
      type: 'image/png',
      size: 12 * MiB,
    })
    const broken: ImageTranscoder = {
      async toJpeg() {
        throw new Error('sips: unsupported format')
      },
    }
    expect(await upload(broken)).toMatchObject({
      type: 'image/png',
      size: 12 * MiB,
    })
  })
})
