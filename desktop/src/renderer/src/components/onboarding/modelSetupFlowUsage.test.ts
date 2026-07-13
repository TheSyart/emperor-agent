import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const rendererRoot = join(__dirname, '..', '..')

describe('first-run model setup flow', () => {
  it('routes the required-model prompt to settings without mounting a second wizard', () => {
    const appSource = readFileSync(join(rendererRoot, 'App.vue'), 'utf8')
    const modelViewSource = readFileSync(
      join(rendererRoot, 'views/ModelView.vue'),
      'utf8',
    )

    expect(appSource).toContain("router.push('/settings/model')")
    expect(appSource).not.toContain('OnboardingWizard')
    expect(appSource).not.toContain('openOnboarding')
    expect(modelViewSource).not.toContain('配置向导')
  })
})
