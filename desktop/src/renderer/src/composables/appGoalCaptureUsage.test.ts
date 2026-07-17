import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const app = readFileSync(join(__dirname, '../App.vue'), 'utf8')
const context = readFileSync(join(__dirname, 'useAppContext.ts'), 'utf8')

describe('App Goal capture integration', () => {
  it('shares Plan and Goal capture controls through App context', () => {
    expect(app).toContain('createGoalCaptureController')
    expect(app).toContain('goalCaptureState: goalCapture.state')
    expect(app).toContain('armGoalCapture: goalCapture.arm')
    expect(app).toContain('cancelGoalCapture: goalCapture.reset')
    expect(app).toContain('startCapturedGoal: goalCapture.start')
    expect(app).toContain('setPlanEnabled')

    expect(context).toContain('goalCaptureState: Ref<GoalCaptureProjection>')
    expect(context).toMatch(/setPlanEnabled:\s*\(\s*enabled: boolean/)
    expect(context).toContain('armGoalCapture: () =>')
    expect(context).toContain('startCapturedGoal:')
  })

  it('clears ephemeral Goal capture when the active session changes', () => {
    expect(app).toContain('goalCapture.reset()')
    expect(app).toContain('watch(sessionId')
  })
})
