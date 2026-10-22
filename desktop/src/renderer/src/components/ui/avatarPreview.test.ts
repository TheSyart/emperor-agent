import { describe, expect, it } from 'vitest'
import { sampleAvatarPreview, createAvatarPreviewPlayer } from './avatarPreview'
describe('settings character timeline', () => {
  it('holds 2.4 seconds, crossfades for 320ms, scales and wraps all 36 frames', () => {
    expect(sampleAvatarPreview(0, 36)).toMatchObject({
      current: 0,
      next: 1,
      mix: 0,
      nextScale: 0.94,
    })
    expect(sampleAvatarPreview(2400, 36).mix).toBe(0)
    expect(sampleAvatarPreview(2560, 36)).toMatchObject({
      mix: 0.5,
      currentScale: 0.97,
      nextScale: 0.97,
    })
    expect(sampleAvatarPreview(2720, 36)).toMatchObject({ current: 1, mix: 0 })
    for (let i = 0; i < 36; i++)
      expect(sampleAvatarPreview(i * 2720, 36).current).toBe(i)
    expect(sampleAvatarPreview(36 * 2720, 36).current).toBe(0)
    for (const time of [NaN, Infinity])
      expect(() => sampleAvatarPreview(time, 36)).toThrow()
    expect(() => sampleAvatarPreview(0, 0)).toThrow()
  })
  it('waits for decode, runs one RAF, pauses hidden/reduced without time jumps and tears down', async () => {
    let callback: ((time: number) => void) | undefined,
      painted = 0,
      ready!: () => void
    const pending = new Promise<void>((resolve) => {
      ready = resolve
    })
    const player = createAvatarPreviewPlayer({
      count: 36,
      decode: () => pending,
      paint: () => {
        painted++
      },
      request: (cb) => {
        expect(callback).toBeUndefined()
        callback = cb
        return 1
      },
      cancel: () => {
        callback = undefined
      },
    })
    expect(callback).toBeUndefined()
    ready()
    await player.ready
    expect(callback).toBeTruthy()
    const tick = (time: number) => {
      const cb = callback!
      callback = undefined
      cb(time)
    }
    tick(100)
    tick(2660)
    expect(player.getTime()).toBe(2560)
    player.setHidden(true)
    expect(callback).toBeUndefined()
    player.setHidden(false)
    tick(50000)
    expect(player.getTime()).toBe(2560)
    player.setReducedMotion(true)
    expect(callback).toBeUndefined()
    player.setReducedMotion(false)
    tick(60000)
    expect(player.getTime()).toBe(2560)
    player.destroy()
    player.destroy()
    expect(callback).toBeUndefined()
    const before = painted
    player.setHidden(false)
    expect(painted).toBe(before)
  })
  it('keeps a static pose on decode failure and initial reduced motion', async () => {
    let scheduled = 0,
      failure = false
    const player = createAvatarPreviewPlayer({
      count: 36,
      reduced: true,
      decode: async () => {
        throw Error('decode')
      },
      paint: () => {},
      request: () => ++scheduled,
      cancel: () => {},
      failed: () => {
        failure = true
      },
    })
    await player.ready
    expect(scheduled).toBe(0)
    expect(failure).toBe(true)
    player.destroy()
  })
})
