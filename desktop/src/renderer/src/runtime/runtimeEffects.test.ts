import { describe, expect, it } from 'vitest'
import type { WsEvent } from '../types'
import {
  createRuntimeEffectState,
  reduceRuntimeEffects,
} from './runtimeEffects'

describe('runtimeEffects', () => {
  it('refreshes only the command catalog for live Skill catalog changes', () => {
    const transition = reduceRuntimeEffects(createRuntimeEffectState(), {
      type: 'runtime_event_committed',
      origin: 'live',
      sessionId: 'session_1',
      event: {
        event: 'skill_catalog_changed',
        seq: 8,
        catalog_version: 2,
      } as WsEvent,
    })

    expect(transition.effects).toEqual([
      expect.objectContaining({
        type: 'refresh_commands',
        sessionId: 'session_1',
        eventSeq: 8,
      }),
    ])
  })

  it('does not replay catalog refresh side effects from history', () => {
    const transition = reduceRuntimeEffects(createRuntimeEffectState(), {
      type: 'runtime_event_committed',
      origin: 'replay',
      sessionId: 'session_1',
      event: { event: 'skill_catalog_changed', seq: 8 } as WsEvent,
    })
    expect(transition.effects).toEqual([])
  })
})
