import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const component = readFileSync(join(__dirname, 'HooksPanel.vue'), 'utf8')
const controller = readFileSync(
  join(__dirname, 'hooksPanelController.ts'),
  'utf8',
)

describe('HooksPanel controller/view/style ownership', () => {
  it('keeps stateful Hooks behavior in the controller and the SFC as a view', () => {
    expect(component).toContain('useHooksPanelController()')
    expect(component).not.toContain("from '../../api/http'")
    expect(component).not.toContain("core('hooks.")
    expect(controller).toContain("core('hooks.getConfig')")
    expect(controller).toContain("core('hooks.testRun'")
    expect(controller).toContain("core('hooks.saveConfig'")
    expect(component.split('\n').length).toBeLessThan(1950)
  })

  it('retains the panel accessibility contract and owns its scoped styles', () => {
    expect(component).toContain('role="tablist"')
    expect(component).toContain('aria-label="Hooks views"')
    expect(component).toContain('role="tab"')
    expect(component).toContain('<style scoped>')
  })
})
