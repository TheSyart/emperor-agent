import { describe, expect, it } from 'vitest'
import type { ControlInteraction, SessionInfo } from '../../types'
import {
  activeBottomControlPanel,
  activeBottomControlPanelForInteraction,
  composerBlockedByControl,
  pendingInteractionForSession,
} from './bottomControlPanel'

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

describe('bottom control panel model', () => {
  it('projects only waiting Ask and Plan interactions into the bottom control slot', () => {
    expect(activeBottomControlPanelForInteraction(interaction())).toMatchObject(
      {
        kind: 'ask',
        interaction: { id: 'control-1' },
      },
    )
    expect(
      activeBottomControlPanelForInteraction(interaction({ kind: 'plan' })),
    ).toMatchObject({
      kind: 'plan',
      interaction: { id: 'control-1' },
    })
    expect(
      activeBottomControlPanelForInteraction(
        interaction({ status: 'answered' }),
      ),
    ).toBeNull()
    expect(
      activeBottomControlPanelForInteraction(
        interaction({ kind: 'plan', meta: { provisional: true } }),
      ),
    ).toBeNull()
    expect(activeBottomControlPanelForInteraction(null)).toBeNull()
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
    const panel = activeBottomControlPanel(
      { mode: 'plan', pending: interaction({ kind: 'ask' }) },
      active,
    )

    expect(panel).toMatchObject({
      kind: 'ask',
      interaction: { id: 'control-1' },
    })
    expect(
      composerBlockedByControl(
        { mode: 'plan', pending: interaction({ kind: 'ask' }) },
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
    const panel = activeBottomControlPanel(
      { mode: 'plan', pending: interaction({ kind: 'plan' }) },
      active,
    )

    expect(panel).toMatchObject({
      kind: 'plan',
      interaction: { id: 'control-1' },
    })
    expect(
      composerBlockedByControl(
        { mode: 'plan', pending: interaction({ kind: 'plan' }) },
        active,
      ),
    ).toBe(true)
  })

  it('does not block the active composer for a pending interaction owned by another session', () => {
    const active = session({ control_pending: null })
    const otherPending = {
      mode: 'plan',
      pending: interaction({ kind: 'plan' }),
    }

    expect(activeBottomControlPanel(otherPending, active)).toBeNull()
    expect(composerBlockedByControl(otherPending, active)).toBe(false)
  })

  it('uses explicit interaction ownership without requiring the legacy session tag', () => {
    const pending = interaction({
      meta: { control_session_id: 'session-1' },
    })

    expect(
      pendingInteractionForSession(
        { mode: 'smart_auto', pending },
        session({ control_pending: null }),
      ),
    ).toBe(pending)
    expect(
      pendingInteractionForSession(
        { mode: 'smart_auto', pending },
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
    const control = { mode: 'plan', pending: interaction({ kind: 'plan' }) }

    expect(activeBottomControlPanel(control, active)).toBeNull()
    expect(composerBlockedByControl(control, active)).toBe(false)
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
      activeBottomControlPanel(
        {
          mode: 'plan',
          pending: interaction({ kind: 'ask', status: 'answered' }),
        },
        active,
      ),
    ).toBeNull()
    expect(
      activeBottomControlPanel(
        {
          mode: 'plan',
          pending: interaction({ kind: 'plan', status: 'approved' }),
        },
        active,
      ),
    ).toBeNull()
    expect(
      composerBlockedByControl({ mode: 'plan', pending: null }, active),
    ).toBe(false)
  })
})
