import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const rendererRoot = join(__dirname, '..', '..')
const source = (path: string) => readFileSync(join(rendererRoot, path), 'utf8')

describe('first-run guide (UI-S17)', () => {
  it('adds the model with the add-model steps, not a second form', () => {
    const guide = source('components/onboarding/FirstRunOnboarding.vue')

    expect(guide).toContain('createAddModelController')
    expect(guide).toContain('<ConnectStep')
    expect(guide).toContain('<PickModelsStep')
    expect(guide).toContain('<ConfirmParamsStep')
    expect(guide).not.toContain('<TextField')
    expect(guide).not.toContain('saveModelEntries')
  })

  it('replaces the first-run dialog and is decided once at launch', () => {
    const app = source('App.vue')

    expect(app).toContain('<FirstRunOnboarding')
    expect(app).toContain('shouldOpenFirstRun')
    expect(app).toContain('firstRunChecked')
    expect(app).not.toContain('ModelSetupRequiredDialog')
    expect(app).not.toContain('OnboardingWizard')
  })

  it('keeps a way back on the hero', () => {
    const chat = source('components/conversation/ConversationView.vue')
    const row = source('components/conversation/HeroModelPrompt.vue')

    expect(chat).toContain('<HeroModelPrompt')
    expect(row).toContain('ctx.openModelSetup()')
    expect(row).toContain("settingsRoute.openSettings('model')")
  })
})
