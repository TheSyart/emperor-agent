import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

describe('profile onboarding renderer flow', () => {
  it('shows a compact pending prompt and dedicated onboarding Ask actions', () => {
    const chat = source('../../views/ChatView.vue')
    const ask = source('../chat/ActiveAskPanel.vue')

    expect(chat).toContain('profile-onboarding-banner')
    expect(chat).toContain('开始访谈')
    expect(chat).toContain('不再提醒')
    expect(ask).toContain("'稍后再说'")
    expect(ask).toContain('skipProfileInterview')
    expect(ask).toContain('补充你的实际情况或其他说明（可选）')
    expect(ask).toContain('askFreeformPresentation')
    expect(ask).toContain('isProfileOnboardingAsk')
  })

  it('shows the active private profile path and allows skipped interviews to restart', () => {
    const configs = source('../../views/ConfigsView.vue')

    expect(configs).toContain('memory/profile/USER.local.md')
    expect(configs).toContain('重新开始')
    expect(configs).toContain('profileOnboarding')
  })
})
