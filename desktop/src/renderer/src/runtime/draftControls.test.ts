// FIX-13 · 3: the start page shows its draft's own plan mode and preset,
// and no goal, never the previous chat's.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import type { BootstrapPayload, SessionInfo } from '../types'
import { showDraftControls } from './draftControls'
import { createDraftSession } from './sessionDrafts'

describe('showDraftControls', () => {
  it('3 · the start page shows its draft, not the previous chat', async () => {
    const boot = ref({
      control: {
        version: 3,
        mode: 'danger-full-access',
        preset: 'danger-full-access',
        plan: true,
        pending: { id: 'ask-1' },
        presets: [{ value: 'read-only', name: '只读', description: '' }],
      },
      goals: { active: { id: 'goal-a', phase: 'active' } },
    } as unknown as BootstrapPayload)
    const draft = createDraftSession()
    let resolveDefaults!: (value: unknown) => void
    const shown = showDraftControls(
      boot,
      () => draft,
      () => new Promise((resolve) => (resolveDefaults = resolve)),
    )
    // At once: no plan, nothing pending, no goal.
    expect(boot.value!.control).toMatchObject({ plan: false, pending: null })
    expect(boot.value!.goals).toEqual({ active: null })
    resolveDefaults({
      version: 3,
      mode: 'workspace-write',
      preset: 'workspace-write',
      plan: false,
      pending: null,
      presets: [],
    })
    await shown
    expect(boot.value!.control).toMatchObject({
      preset: 'workspace-write',
      mode: 'workspace-write',
      plan: false,
      pending: null,
    })

    const own = { ...draft, plan: true, preset: 'read-only' } as SessionInfo
    await showDraftControls(
      boot,
      () => own,
      async () => undefined,
    )
    expect(boot.value!.control).toMatchObject({
      preset: 'read-only',
      plan: true,
    })
  })

  it('3 · leaving the draft before the defaults arrive leaves the next chat alone', async () => {
    const boot = ref({
      control: { preset: 'workspace-write', plan: false },
    } as unknown as BootstrapPayload)
    const draft = createDraftSession()
    let onScreen: SessionInfo | undefined = draft
    let resolveDefaults!: (value: unknown) => void
    const shown = showDraftControls(
      boot,
      () => onScreen,
      () => new Promise((resolve) => (resolveDefaults = resolve)),
    )
    onScreen = undefined
    boot.value!.control = { preset: 'read-only', plan: true }
    resolveDefaults({ preset: 'workspace-write', plan: false })
    await shown
    expect(boot.value!.control).toEqual({ preset: 'read-only', plan: true })
  })
})

describe('App.vue on the start page (FIX-13)', () => {
  const app = readFileSync(join(__dirname, '../App.vue'), 'utf8')

  it('3 · shows the draft when it is activated, and the defaults from Core', () => {
    expect(app).toContain("await import('./runtime/draftControls')")
    expect(app).toContain("() => core('control.get', null)")
    // A real session still loads its own bootstrap.
    expect(app).toContain(
      'await bootstrap.loadBootstrap(false, sessionStore.backendSessionId())',
    )
  })

  it('4 · a typed command waits for the session a first message is creating', () => {
    expect(app).toContain('const sending = await draftSession(draftId)')
  })

  it('1 · keeps plan mode and the preset on the draft, and sends them with it', () => {
    expect(app).toContain('updateDraft: sessionStore.updateDraft')
    expect(app).toContain('draftSessionOf(draft)')
  })
})
