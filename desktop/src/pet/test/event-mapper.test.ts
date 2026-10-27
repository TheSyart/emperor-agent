import { describe, expect, it } from 'vitest'
import { mapPetEvent } from '../event-mapper.js'

describe('pet event mapper', () => {
  it('maps the closed redacted activity contract', () => {
    expect(
      mapPetEvent({
        type: 'activity',
        animation: 'building',
        label: 'running',
      }),
    ).toEqual({ animation: 'building', bubble: '正在运行命令。' })
    expect(
      mapPetEvent({
        type: 'activity',
        animation: 'conducting',
        label: 'delegating',
        subagentDelta: 1,
      }),
    ).toEqual({
      animation: 'conducting',
      bubble: '正在派遣队友。',
      subagentDelta: 1,
    })
  })

  it('maps attention and connection state without free-form detail', () => {
    expect(mapPetEvent({ type: 'attention', kind: 'approval' })).toEqual({
      animation: 'notification',
      bubble: '需要主人拍板。',
      bubbleDurationMs: 0,
    })
    expect(mapPetEvent({ type: 'attention', kind: 'done' })).toEqual({
      animation: 'happy',
      bubble: '办好了。',
      resetAfterMs: 4000,
    })
    expect(mapPetEvent({ type: 'connection', online: false })).toEqual({
      animation: 'disconnected',
      bubble: '连接 Agent 事件失败。',
    })
  })

  it('does not understand raw runtime payloads', () => {
    expect(
      mapPetEvent({
        event: 'tool_call',
        name: 'run_command',
        arguments: { command: 'cat /private/secret' },
      }),
    ).toBeNull()
    expect(mapPetEvent({ type: 'activity', label: 'unknown' })).toBeNull()
  })
})

describe('the pet’s outfits (BRD-04)', () => {
  it('finds each strip in its outfit’s folder', async () => {
    const { stripPath, PET_OUTFITS, SPRITES } =
      await import('../event-mapper.js')
    expect(PET_OUTFITS).toEqual(['daily', 'robe', 'original'])
    expect(stripPath('daily', SPRITES.idle!)).toBe(
      'xiaodan-daily/daily-idle.webp',
    )
    expect(stripPath('robe', SPRITES.cheer!)).toBe(
      'xiaodan-robe/robe-cheer.webp',
    )
    expect(stripPath('original', SPRITES.doze!)).toBe(
      'xiaodan/xiaodan-doze.webp',
    )
  })

  it('dresses an unknown outfit in everyday clothes', async () => {
    const { stripPath, SPRITES } = await import('../event-mapper.js')
    expect(stripPath('penguin', SPRITES.walk!)).toBe(
      'xiaodan-daily/daily-walk.webp',
    )
    expect(stripPath(undefined, SPRITES.walk!)).toBe(
      'xiaodan-daily/daily-walk.webp',
    )
  })

  it('has every strip of every outfit on disk', async () => {
    const { existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { stripPath, PET_OUTFITS, SPRITES } =
      await import('../event-mapper.js')
    const root = join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'assets',
      'desktop-pet',
    )
    for (const outfit of PET_OUTFITS)
      for (const sprite of Object.values(SPRITES))
        expect(existsSync(join(root, stripPath(outfit, sprite))), outfit).toBe(
          true,
        )
  })
})
