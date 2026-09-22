import { describe, expect, it } from 'vitest'
import type { HooksConfigPayload } from '../../../types'
import {
  auditQuery,
  hookEventCountRows,
  hookExitTone,
  hookMatchQueryLabel,
  hookOutcomeTone,
  hooksEditorSeed,
  totalHookCount,
} from './hooksModel'

const payload = {
  path: '/state/hooks.json',
  content: '',
  files: ['/state/hooks.json', '/repo/.claude/settings.json'],
  events: { PreToolUse: 2, Stop: 1 },
  errors: [],
  supportedEvents: ['SessionStart', 'PreToolUse', 'Stop'],
} as unknown as HooksConfigPayload

describe('hooks settings model', () => {
  it('counts runnable command hooks per supported event', () => {
    expect(hookEventCountRows(payload)).toEqual([
      { eventName: 'SessionStart', count: 0 },
      { eventName: 'PreToolUse', count: 2 },
      { eventName: 'Stop', count: 1 },
    ])
    expect(totalHookCount(payload)).toBe(3)
  })

  it('seeds an empty Claude Code hooks document', () => {
    expect(hooksEditorSeed(payload)).toContain('"hooks"')
    expect(
      hooksEditorSeed({ ...payload, content: '{"hooks":{"Stop":[]}}' }),
    ).toBe('{"hooks":{"Stop":[]}}')
  })

  it('labels matcher fields and builds audit queries', () => {
    expect(hookMatchQueryLabel('tool_name')).toContain('工具名')
    expect(hookMatchQueryLabel(null)).toContain('不使用')
    expect(auditQuery({ eventName: 'Stop', cursor: '50' })).toEqual({
      limit: 50,
      eventName: 'Stop',
      cursor: '50',
    })
  })

  it('maps audit outcomes and exit codes to badge tones', () => {
    expect(hookOutcomeTone('allow')).toBe('ok')
    expect(hookOutcomeTone('approve')).toBe('ok')
    expect(hookOutcomeTone('deny')).toBe('error')
    expect(hookOutcomeTone('block')).toBe('error')
    expect(hookOutcomeTone(null)).toBe('neutral')
    expect(hookExitTone(0)).toBe('ok')
    expect(hookExitTone(2)).toBe('error')
    expect(hookExitTone(1)).toBe('warn')
    expect(hookExitTone(null)).toBe('neutral')
  })
})
