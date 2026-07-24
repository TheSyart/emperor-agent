import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(__dirname, 'ChatView.vue'), 'utf8')

describe('ChatView right workspace integration', () => {
  it('removes the chat header and mounts the Core-owned workspace beside chat', () => {
    expect(source).not.toContain('<header class="view-head">')
    expect(source).not.toContain('ctx.runtimeText()')
    expect(source).toContain('<RightWorkspace')
    expect(source).not.toContain('suppress-environment')
    expect(source).toContain('chat-workspace-layout')
  })
})
