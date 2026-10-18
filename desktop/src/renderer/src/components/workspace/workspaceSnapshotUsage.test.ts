// Guards W-2 (PLAN-V020 findings): the shared workspace snapshot follows the
// active session. Binding it to the viewed session reset the built-in browser
// and the Files tabs whenever the user left chat for a full page or opened a
// read-only child log.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const app = readFileSync(join(__dirname, '../../App.vue'), 'utf8')
const binding = app.slice(app.indexOf('bindWorkspaceSnapshotSource({'))
const block = binding.slice(0, binding.indexOf('})') + 2)

describe('workspace snapshot binding', () => {
  it('follows the active session, not the viewed one', () => {
    expect(block).toContain('sessionId: () => sessionId.value')
    expect(block).not.toContain('viewedSessionId')
  })

  it('keeps the image viewer owned by the viewed session', () => {
    expect(app).toContain('<ImageViewerHost :owner="viewedSessionId" />')
  })
})
