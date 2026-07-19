import { describe, expect, it } from 'vitest'
import type { ModelConfigPayload } from '../../types'
import {
  buildModelSetupDialogContent,
  shouldShowModelSetupPrompt,
} from './modelSetupDialogModel'

describe('model setup dialog content', () => {
  it('presents unavailable model setup as an onboarding modal instead of an error prompt', () => {
    const content =
      buildModelSetupDialogContent('还没有可用模型，请先配置模型。')

    expect(content.brandAlt).toBe('emperoragent')
    expect(content.title).toBe('把任务交给本地 Agent。')
    expect(content.subtitle).toContain('接入一个可用模型')
    expect(content.status).toBe('还没有可用模型，请先配置模型。')
    expect(content.primaryAction).toBe('去配置模型')
    expect(content.secondaryAction).toBe('稍后配置')
    expect('badges' in content).toBe(false)
    expect('features' in content).toBe(false)
  })

  it('shows the first-run prompt only while the effective model is unavailable', () => {
    expect(
      shouldShowModelSetupPrompt({
        app: 'Emperor Agent',
        tools: [],
        skills: [],
        memory: {},
        profileOnboarding: pendingProfileOnboarding(),
        modelConfig: modelConfig(false, '请配置模型'),
      }),
    ).toBe(true)
    expect(
      shouldShowModelSetupPrompt({
        app: 'Emperor Agent',
        tools: [],
        skills: [],
        memory: {},
        profileOnboarding: pendingProfileOnboarding(),
        modelConfig: modelConfig(true, '模型可用'),
      }),
    ).toBe(false)
  })
})

function pendingProfileOnboarding() {
  return {
    status: 'pending' as const,
    sessionId: null,
    interactionId: null,
    attemptCount: 0,
    lastError: null,
    canStart: true,
    canSkip: true,
  }
}

function modelConfig(usable: boolean, message: string): ModelConfigPayload {
  return {
    schemaVersion: 2 as const,
    activeModelId: null,
    models: [],
    current: null,
    policy: {
      fallback: {
        enabled: false,
        entryId: null,
        triggerOn: ['rate_limit'],
      },
      cost: { maxUsdPerAgentTurn: null },
    },
    availability: { usable, message },
    providerOptions: [],
  }
}
