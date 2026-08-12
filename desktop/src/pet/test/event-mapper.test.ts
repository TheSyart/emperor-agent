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
