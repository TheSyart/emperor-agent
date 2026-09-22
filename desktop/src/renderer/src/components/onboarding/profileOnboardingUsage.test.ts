import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

describe('profile onboarding renderer flow', () => {
  it('shows a compact pending onboarding prompt in the chat view', () => {
    const chat = source('../conversation/ConversationView.vue')

    expect(chat).toContain('showProfileOnboardingPrompt')
    expect(chat).toContain('开始访谈')
    expect(chat).toContain('不再提醒')
  })

  it('gives the onboarding Ask takeover dedicated actions', () => {
    const ask = source('../conversation/takeover/QuestionComposer.vue')
    const askModel = source('../conversation/takeover/questionModel.ts')

    expect(ask).toContain("'稍后再说'")
    expect(ask).toContain('不再提醒')
    expect(ask).toContain('skipProfileInterview')
    expect(askModel).toContain('补充你的实际情况或其他说明（可选）')
    expect(ask).toContain('askFreeformPresentation')
    expect(ask).toContain('isProfileOnboardingAsk')
  })

  it('shows the active private profile path and allows skipped interviews to restart', () => {
    const configs = source('../settings/ConfigsSection.vue')

    expect(configs).toContain('memory/profile/USER.local.md')
    expect(configs).toContain('重新开始')
    expect(configs).toContain('profileOnboarding')
  })
})
