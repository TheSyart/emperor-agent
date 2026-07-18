import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(__dirname, 'SessionSidebar.vue'), 'utf8')

describe('SessionSidebar deletion safeguards', () => {
  it('disables deletion of the last persisted session and reports Core failures', () => {
    expect(source).toContain('canDeletePersistedSession')
    expect(source).toContain('sessionActionError')
    expect(source).toContain(':disabled="!s.draft && !canDeletePersistedSession"')
    expect(source).toContain('ctx.showToast')
  })
})
