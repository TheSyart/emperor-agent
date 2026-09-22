import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(join(__dirname, path), 'utf8')

const views = {
  section: read('../HooksSection.vue'),
  config: read('HooksConfigTab.vue'),
  test: read('HooksTestTab.vue'),
  audit: read('HooksAuditTab.vue'),
}
const controller = read('hooksController.ts')

describe('Hooks settings controller/view ownership', () => {
  it('keeps every hooks.* Core call in the controller; views only render', () => {
    expect(views.section).toContain('provideHooksController()')
    for (const [name, source] of Object.entries(views)) {
      expect(source, name).not.toContain('api/http')
      expect(source, name).not.toContain("core('hooks.")
      expect(source, name).not.toContain('window.confirm')
    }
    for (const view of [views.config, views.test, views.audit])
      expect(view).toContain('useHooksController()')
    for (const op of [
      'hooks.getConfig',
      'hooks.getMetadata',
      'hooks.getAudit',
      'hooks.validateConfig',
      'hooks.saveConfig',
      'hooks.testMatch',
      'hooks.testRun',
    ])
      expect(controller).toContain(`'${op}'`)
  })

  it('runs a matched command only after the inline confirmation', () => {
    expect(controller).toContain('confirmExecution: true')
    expect(controller).toMatch(/async function confirmRun\(\)/)
    expect(views.test).toContain('@click="requestRun(item)"')
    expect(views.test).toContain('@click="confirmRun"')
  })

  it('keeps the tab accessibility contract', () => {
    expect(views.section).toContain('aria-label="Hooks views"')
    expect(views.section).toContain('<Tabs')
  })
})
