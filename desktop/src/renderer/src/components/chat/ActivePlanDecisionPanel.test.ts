import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function componentSource(): string {
  return readFileSync(fileURLToPath(new URL('./ActivePlanDecisionPanel.vue', import.meta.url)), 'utf8')
}

describe('ActivePlanDecisionPanel markup', () => {
  it('renders the custom adjustment input as a second plan decision option', () => {
    const source = componentSource()

    expect(source).toContain('class="active-plan-decision-option active-plan-decision-freeform"')
    expect(source).toContain('<span class="active-ask-number">2</span>')
    expect(source).toContain('placeholder="否，请告诉emperor如何调整"')
    expect(source).not.toContain('写下修改意见，Agent 会据此重出计划')
  })
})
