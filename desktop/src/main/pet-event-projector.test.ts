import { describe, expect, it } from 'vitest'
import { projectPetEvent } from './pet-event-projector'

describe('PetEventProjector', () => {
  it('projects only closed enums and drops poison content', () => {
    const secret = 'sk-live-do-not-leak'
    const raw = {
      event: 'tool_call',
      name: 'run_command',
      arguments: {
        command: `cat /Users/private/.env ${secret}`,
        path: '/Users/private/.ssh/id_ed25519',
        url: `https://token.example/${secret}`,
      },
      content: secret,
      delta: secret,
      environment: { API_KEY: secret },
      authorization: { fingerprint: secret },
    }

    const projected = projectPetEvent(raw)

    expect(projected).toEqual({
      type: 'activity',
      animation: 'building',
      label: 'running',
    })
    const serialized = JSON.stringify(projected)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('/Users')
    expect(serialized).not.toContain('https://')
    expect(serialized).not.toContain('command')
  })

  it('maps attention and teammate lifecycle without raw summaries', () => {
    expect(
      projectPetEvent({
        event: 'ask_request',
        interaction: { title: 'secret approval title' },
      }),
    ).toEqual({ type: 'attention', kind: 'approval' })
    expect(
      projectPetEvent({
        event: 'subagent_start',
        purpose: 'secret mission',
      }),
    ).toEqual({
      type: 'activity',
      animation: 'conducting',
      label: 'delegating',
      subagentDelta: 1,
    })
    expect(
      projectPetEvent({ event: 'assistant_done', content: 'secret result' }),
    ).toEqual({ type: 'attention', kind: 'done' })
  })

  it('drops events with no pet-visible state transition', () => {
    expect(projectPetEvent({ event: 'context_projection', secret: true })).toBe(
      null,
    )
    expect(projectPetEvent({ event: 'unknown' })).toBeNull()
  })
})
