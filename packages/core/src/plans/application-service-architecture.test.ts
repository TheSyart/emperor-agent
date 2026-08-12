import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Planning application ownership', () => {
  it('routes approval, recovery, tools, and Runner mutations through the application service', () => {
    const api = source('../api/core-api.ts')
    const loop = source('../agent/loop.ts')
    const runner = source('../agent/runner.ts')
    const service = source('./application-service.ts')

    expect(api).toContain('planningApplicationService.approve')
    expect(api).not.toContain('goalPlanBridge.preflightApproval')
    expect(api).not.toContain('goalPlanBridge.prepareApproval')
    expect(api).not.toContain('goalPlanBridge.bindApprovedPlan')
    expect(api).not.toContain('goalPlanBridge.abortFailedApproval')

    expect(loop).toContain('planningApplicationService.recover()')
    expect(loop).toContain('planningApplicationService.forSession(')
    expect(loop).not.toContain('goalPlanBridge.recoverQuarantinedApprovals')
    expect(loop).not.toContain('goalPlanBridge.recoverIncompleteSkips')
    expect(loop).not.toContain('goalPlanBridge.recoverIncompleteReplans')

    expect(runner).toContain('recordPlanDiscovery(this.planning')
    expect(runner).toContain('this.planning?.pausePlanExecution')
    expect(runner).toContain('this.planning?.resumePlanExecution')
    expect(runner).not.toContain('this.controlManager?.pausePlanExecution?.')
    expect(runner).not.toContain('this.controlManager?.resumePlanExecution?.')

    for (const useCase of [
      'enterPlan(',
      'recordDiscovery(',
      'propose(',
      'comment(',
      'approve(',
      'activate(',
      'claimStep(',
      'recordVerification(',
      'pause(',
      'resume(',
      'skip(',
      'replan(',
      'cancel(',
      'recover(',
    ])
      expect(service).toContain(useCase)
  })
})

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}
