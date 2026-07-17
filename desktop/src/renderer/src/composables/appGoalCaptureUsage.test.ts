import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const app = readFileSync(join(__dirname, '../App.vue'), 'utf8')
const context = readFileSync(join(__dirname, 'useAppContext.ts'), 'utf8')
const slashCommands = readFileSync(
  join(__dirname, 'useSlashCommands.ts'),
  'utf8',
)

describe('App Goal capture integration', () => {
  it('shares one mutually exclusive lifecycle controller through App context', () => {
    expect(app).toContain('createGoalCaptureController')
    expect(slashCommands).toContain('createComposerLifecycleController')
    expect(app).toContain('goalCaptureState: goalCapture.state')
    expect(app).toContain('activatePlan,')
    expect(app).toContain('activateGoalCapture,')
    expect(app).toContain('startGoalWithLifecycle,')
    expect(app).toContain('dismissLifecycle,')

    expect(context).toContain('goalCaptureState: Ref<GoalCaptureProjection>')
    expect(context).toContain('activatePlan:')
    expect(context).toContain('activateGoalCapture:')
    expect(context).toContain('startGoalWithLifecycle:')
    expect(context).toContain('dismissLifecycle:')
  })

  it('clears ephemeral Goal capture when the active session changes', () => {
    expect(app).toContain('goalCapture.reset()')
    expect(app).toContain('watch(sessionId')
  })

  it('reconciles terminal Goals from bootstrap and runtime projections', () => {
    expect(app).toContain('currentGoal.value?.id || null')
    expect(app).toContain('current.sessionId !== previous.sessionId')
    expect(app).toContain('reconcileTerminalGoal(previous.goalId)')
  })
})
