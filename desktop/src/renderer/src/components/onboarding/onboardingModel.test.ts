import { describe, expect, it } from 'vitest'
import type { BootstrapPayload } from '../../types'
import { shouldShowModelSetupPrompt } from './modelSetupDialogModel'

describe('onboarding model availability (MIG-APP-001)', () => {
  it('keeps the migration parity test on the single first-run prompt', () => {
    expect(shouldShowModelSetupPrompt(boot(false))).toBe(true)
    expect(shouldShowModelSetupPrompt(boot(true))).toBe(false)
  })
})

function boot(usable: boolean): BootstrapPayload {
  return {
    app: 'Emperor Agent',
    tools: [],
    skills: [],
    memory: {},
    profileOnboarding: {
      status: 'pending',
      sessionId: null,
      interactionId: null,
      attemptCount: 0,
      lastError: null,
      canStart: true,
      canSkip: true,
    },
    modelConfig: {
      availability: {
        usable,
        message: usable ? '模型已配置' : '还没有可用模型，请先配置模型。',
      },
    },
  }
}
