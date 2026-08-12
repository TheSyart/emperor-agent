import { describe, expect, it } from 'vitest'
import {
  isRuntimeEventWire,
  parseRuntimeEventWire,
  RUNTIME_EVENT_NAMES,
} from './wire-contract'

describe('runtime wire contract', () => {
  it('accepts registered current and legacy-compatible payloads', () => {
    expect(RUNTIME_EVENT_NAMES).toContain('project_process_update')
    expect(RUNTIME_EVENT_NAMES).toContain('website_preview_update')
    expect(
      parseRuntimeEventWire({
        event: 'assistant_done',
        content: 'done',
        legacy_extra: true,
      }),
    ).toMatchObject({ event: 'assistant_done', legacy_extra: true })
  })

  it('rejects unknown event discriminants at the wire boundary', () => {
    expect(isRuntimeEventWire({ event: 'not_registered', secret: 'x' })).toBe(
      false,
    )
    expect(() => parseRuntimeEventWire({ event: 'not_registered' })).toThrow()
  })
})
