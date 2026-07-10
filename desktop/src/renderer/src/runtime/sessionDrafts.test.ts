import { describe, expect, it } from 'vitest'

const NOW = '2026-01-01T00:00:00+0800'

function session(extra: Record<string, unknown> = {}) {
  return {
    id: 'session',
    title: '会话',
    created_at: NOW,
    updated_at: NOW,
    preview: '',
    version: 1,
    ...extra,
  }
}

describe('session draft helpers', () => {
  it('creates a local draft session without backend fields changing shape', async () => {
    const { createDraftSession, isDraftSessionId } = await import('./sessionDrafts')

    const draft = createDraftSession()

    expect(isDraftSessionId(draft.id)).toBe(true)
    expect(draft.title).toBe('新会话')
    expect(draft.draft).toBe(true)
    expect(draft.title_status).toBe('draft')
  })

  it('creates a build draft session with project metadata', async () => {
    const { createDraftSession } = await import('./sessionDrafts')

    const draft = createDraftSession({
      mode: 'build',
      projectId: 'proj_1',
      projectPath: '/tmp/demo',
      projectName: 'demo',
    })

    expect(draft.mode).toBe('build')
    expect(draft.project_id).toBe('proj_1')
    expect(draft.project_path).toBe('/tmp/demo')
    expect(draft.project_name).toBe('demo')
  })

  it('replaces a draft with the committed backend session', async () => {
    const { applySessionCreated, createDraftSession } = await import('./sessionDrafts')
    const draft = createDraftSession()
    const sessions = [draft, session({ id: 'old', title: '旧会话' })]

    const next = applySessionCreated(sessions, {
      event: 'session_created',
      client_draft_id: draft.id,
      session: session({ id: 'real', title: '新会话', preview: 'hello', title_status: 'pending' }),
    })

    expect(next.map((session) => session.id)).toEqual(['real', 'old'])
    expect(next[0].draft).toBeUndefined()
    expect(next[0].preview).toBe('hello')
  })

  it('preserves build metadata when replacing a draft with a committed session', async () => {
    const { applySessionCreated, createDraftSession } = await import('./sessionDrafts')
    const draft = createDraftSession({
      mode: 'build',
      projectId: 'proj_1',
      projectPath: '/tmp/demo',
      projectName: 'demo',
    })

    const next = applySessionCreated([draft], {
      event: 'session_created',
      client_draft_id: draft.id,
      session: session({
        id: 'real',
        title: '构建 demo',
        preview: 'start',
        mode: 'build',
        project_id: 'proj_1',
        project_path: '/tmp/demo',
        project_name: 'demo',
        title_status: 'pending',
      }),
    })

    expect(next[0].id).toBe('real')
    expect(next[0].mode).toBe('build')
    expect(next[0].project_id).toBe('proj_1')
    expect(next[0].project_path).toBe('/tmp/demo')
    expect(next[0].project_name).toBe('demo')
  })

  it('applies generated title updates in place', async () => {
    const { applySessionTitleUpdated } = await import('./sessionDrafts')
    const sessions = [session({ id: 'real', title: '新会话', title_status: 'pending' })]

    const next = applySessionTitleUpdated(sessions, {
      event: 'session_title_updated',
      session: session({ id: 'real', title: '界面重塑', title_status: 'generated' }),
    })

    expect(next[0].title).toBe('界面重塑')
    expect(next[0].title_status).toBe('generated')
  })
})
