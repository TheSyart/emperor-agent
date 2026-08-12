import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('CoreApi application facade ownership', () => {
  it('delegates command, session, and workspace use cases without selected-session authority', () => {
    const source = readFileSync(
      new URL('./core-api.ts', import.meta.url),
      'utf8',
    )
    const sessionService = readFileSync(
      new URL('./services/session-application-service.ts', import.meta.url),
      'utf8',
    )
    const workspaceService = readFileSync(
      new URL('./services/workspace-application-service.ts', import.meta.url),
      'utf8',
    )
    const commandService = readFileSync(
      new URL('./services/command-application-service.ts', import.meta.url),
      'utf8',
    )

    expect(source).toContain('this.commandApplicationService.executeBuiltin')
    expect(source).toContain('this.sessionApplicationService.')
    expect(source).toContain('this.workspaceApplicationService.snapshot')
    expect(source).not.toContain('private async executeBuiltinCommand')
    expect(source).not.toContain('private async executePlanCommand')
    expect(source).not.toContain('private async executeGoalCommand')
    expect(source).not.toContain(
      'this.loop.controlManager.planStore.deleteBySession',
    )
    expect(commandService).not.toContain('activeSessionId')
    expect(commandService).not.toContain('activeSession')
    expect(sessionService).not.toContain('activeSessionId')
    expect(workspaceService).not.toContain('activeSessionId')
    expect(workspaceService).not.toContain('controlManager.planStore')
  })
})
