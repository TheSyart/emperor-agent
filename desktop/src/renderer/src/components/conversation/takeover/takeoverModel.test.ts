import { describe, expect, it } from 'vitest'
import type { ControlInteraction, SessionInfo } from '../../../types'
import {
  activeTakeover,
  activeTakeoverForSession,
  pendingInteractionForSession,
} from './takeoverModel'

function interaction(
  extra: Partial<ControlInteraction> = {},
): ControlInteraction {
  return {
    id: 'control-1',
    kind: 'ask',
    status: 'waiting',
    ...extra,
  }
}

function session(extra: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'session-1',
    title: 'Session',
    created_at: '2026-01-01T00:00:00+0800',
    updated_at: '2026-01-01T00:00:00+0800',
    preview: '',
    message_count: 0,
    title_status: 'manual',
    mode: 'chat',
    project_id: null,
    project_path: null,
    project_name: null,
    archived_at: null,
    control_pending: null,
    version: 1,
    ...extra,
  }
}

function blocked(
  ...args: Parameters<typeof activeTakeoverForSession>
): boolean {
  return Boolean(activeTakeoverForSession(...args))
}

describe('takeover model', () => {
  it('projects only waiting Ask and Plan interactions into the bottom control slot', () => {
    expect(activeTakeover(interaction())).toMatchObject({
      kind: 'question',
      interaction: { id: 'control-1' },
    })
    expect(activeTakeover(interaction({ kind: 'plan' }))).toMatchObject({
      kind: 'plan',
      interaction: { id: 'control-1' },
    })
    expect(activeTakeover(interaction({ status: 'answered' }))).toBeNull()
    expect(
      activeTakeover(
        interaction({ kind: 'plan', meta: { provisional: true } }),
      ),
    ).toBeNull()
    expect(activeTakeover(null)).toBeNull()
  })

  it('uses waiting ask interactions as the bottom panel instead of the composer', () => {
    const active = session({
      control_pending: {
        kind: 'ask',
        label: '需要用户输入',
        tone: 'blue',
        interaction_id: 'control-1',
        updated_at: 1,
      },
    })
    const panel = activeTakeoverForSession(
      {
        preset: 'workspace-write',
        plan: true,
        pending: interaction({ kind: 'ask' }),
      },
      active,
    )

    expect(panel).toMatchObject({
      kind: 'question',
      interaction: { id: 'control-1' },
    })
    expect(
      blocked(
        {
          preset: 'workspace-write',
          plan: true,
          pending: interaction({ kind: 'ask' }),
        },
        active,
      ),
    ).toBe(true)
  })

  it('uses waiting plan interactions as the bottom panel instead of the composer', () => {
    const active = session({
      control_pending: {
        kind: 'plan',
        label: '计划需要用户确认',
        tone: 'green',
        interaction_id: 'control-1',
        updated_at: 1,
      },
    })
    const panel = activeTakeoverForSession(
      {
        preset: 'workspace-write',
        plan: true,
        pending: interaction({ kind: 'plan' }),
      },
      active,
    )

    expect(panel).toMatchObject({
      kind: 'plan',
      interaction: { id: 'control-1' },
    })
    expect(
      blocked(
        {
          preset: 'workspace-write',
          plan: true,
          pending: interaction({ kind: 'plan' }),
        },
        active,
      ),
    ).toBe(true)
  })

  it('trusts the per-session control payload when nothing scopes the interaction', () => {
    const active = session({ control_pending: null })
    const control = {
      preset: 'workspace-write',
      plan: true,
      pending: interaction({ kind: 'plan' }),
    }

    expect(activeTakeoverForSession(control, active)?.kind).toBe('plan')
    expect(blocked(control, active)).toBe(true)
  })

  it('uses explicit interaction ownership without requiring the legacy session tag', () => {
    const pending = interaction({
      meta: { control_session_id: 'session-1' },
    })

    expect(
      pendingInteractionForSession(
        { preset: 'workspace-write', plan: false, pending },
        session({ control_pending: null }),
      ),
    ).toBe(pending)
    expect(
      pendingInteractionForSession(
        { preset: 'workspace-write', plan: false, pending },
        session({ id: 'session-2', control_pending: null }),
      ),
    ).toBeNull()
  })

  it('does not block the active composer when the session tag references a different interaction', () => {
    const active = session({
      control_pending: {
        kind: 'plan',
        label: '计划需要用户确认',
        tone: 'green',
        interaction_id: 'other-control',
        updated_at: 1,
      },
    })
    const control = {
      preset: 'workspace-write',
      plan: true,
      pending: interaction({ kind: 'plan' }),
    }

    expect(activeTakeoverForSession(control, active)).toBeNull()
    expect(blocked(control, active)).toBe(false)
  })

  it('does not block the composer after the control interaction is resolved', () => {
    const active = session({
      control_pending: {
        kind: 'ask',
        label: '需要用户输入',
        tone: 'blue',
        interaction_id: 'control-1',
        updated_at: 1,
      },
    })

    expect(
      activeTakeoverForSession(
        {
          preset: 'workspace-write',
          plan: true,
          pending: interaction({ kind: 'ask', status: 'answered' }),
        },
        active,
      ),
    ).toBeNull()
    expect(
      activeTakeoverForSession(
        {
          preset: 'workspace-write',
          plan: true,
          pending: interaction({ kind: 'plan', status: 'approved' }),
        },
        active,
      ),
    ).toBeNull()
    expect(
      blocked({ preset: 'workspace-write', plan: true, pending: null }, active),
    ).toBe(false)
  })

  it('routes permission asks to the approval card', () => {
    expect(
      activeTakeover(interaction({ meta: { interaction_type: 'permission' } }))
        ?.kind,
    ).toBe('approval')
    expect(
      activeTakeover(interaction({ meta: { interaction_type: 'question' } }))
        ?.kind,
    ).toBe('question')
    expect(activeTakeover(interaction({ kind: 'goal' }))).toBeNull()
  })
})
