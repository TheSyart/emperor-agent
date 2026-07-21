import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { controlStateFromDict } from './models'
import { ControlStore } from './store'

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'emperor-control-mode-v2-'))
}

describe('Control permission mode v2 migration', () => {
  it.each([
    ['ask_before_edit', 'ask_before_edit'],
    ['accept_edits', 'smart_auto'],
    ['auto', 'full_access'],
  ])('migrates legacy %s to %s', (legacy, expected) => {
    const state = controlStateFromDict({
      version: 1,
      mode: legacy,
      previous_mode: null,
      pending: null,
      last_interaction: null,
      updated_at: 1,
    })

    expect(state).toMatchObject({ version: 2, mode: expected })
  })

  it('migrates the permission restored after Plan mode', () => {
    const state = controlStateFromDict({
      version: 1,
      mode: 'plan',
      previous_mode: 'auto',
      pending: null,
      last_interaction: null,
      updated_at: 1,
    })

    expect(state).toMatchObject({
      version: 2,
      mode: 'plan',
      previousMode: 'full_access',
    })
  })

  it('persists a legacy state migration exactly when load owns the write', () => {
    const root = tempRoot()
    const controlDir = join(root, 'control')
    const stateFile = join(controlDir, 'state.json')
    mkdirSync(controlDir, { recursive: true })
    writeFileSync(
      stateFile,
      JSON.stringify({
        version: 1,
        mode: 'auto',
        previous_mode: null,
        pending: null,
        last_interaction: null,
        updated_at: 1,
      }),
      'utf8',
    )

    const store = new ControlStore(root)
    expect(store.inspect().record).toMatchObject({
      version: 2,
      mode: 'full_access',
    })

    store.load()
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toMatchObject({
      version: 2,
      mode: 'full_access',
    })
  })
})
