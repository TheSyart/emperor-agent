import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionStore } from './store'

describe('SessionStore lineage', () => {
  it('persists clear transition lineage without copying conversation state', () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-session-lineage-'))
    const store = new SessionStore(root)
    const parent = store.create('Original', {
      mode: 'build',
      project: {
        project_id: 'project-1',
        project_path: '/workspace/project',
        project_name: 'project',
      },
    })
    const child = store.create('Untitled', {
      mode: parent.mode,
      project: {
        project_id: parent.project_id,
        project_path: parent.project_path,
        project_name: parent.project_name,
      },
      parentSessionId: parent.id,
      lineageRootId: parent.id,
      transitionReason: 'clear',
    })

    expect(store.get(child.id)).toMatchObject({
      parent_session_id: parent.id,
      lineage_root_id: parent.id,
      transition_reason: 'clear',
      message_count: 0,
      control_pending: null,
    })
    expect(store.get(parent.id)?.title).toBe('Original')
  })
})
