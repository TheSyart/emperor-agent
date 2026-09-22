import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = readFileSync(join(__dirname, 'SidebarRoot.vue'), 'utf8')
const row = readFileSync(join(__dirname, 'SessionRow.vue'), 'utf8')

describe('sidebar deletion safeguards and navigation', () => {
  it('disables deletion of the last persisted session and reports Core failures', () => {
    expect(root).toContain('canDeletePersistedSession')
    expect(root).toContain('sessionActionError')
    expect(root).toContain(
      'Boolean(session.draft) || canDeletePersistedSession',
    )
    expect(row).toContain(':disabled="!canDelete"')
    expect(root).toContain('ctx.showToast')
  })

  it('navigates through the /chat/:sessionId route instead of activating directly', () => {
    expect(root).toContain('router.push(sessionLocation(id))')
    expect(root).not.toContain('activate(')
  })

  it('shows running subagent counts from sessions.children', () => {
    expect(root).toContain('subagents.counts[session.id]')
    expect(row).toContain('个子代理运行中')
  })
})
