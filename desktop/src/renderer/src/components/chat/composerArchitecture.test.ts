import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const component = readFileSync(join(__dirname, 'Composer.vue'), 'utf8')
const controller = readFileSync(
  join(__dirname, 'composerController.ts'),
  'utf8',
)
const composerStyles = readFileSync(
  join(__dirname, '../../styles/surfaces/composer.css'),
  'utf8',
)

describe('Composer controller/view/style ownership', () => {
  it('keeps stateful Composer behavior in one controller and the SFC as a view', () => {
    expect(component).toContain('useComposerController(props, emit)')
    expect(component).not.toContain('useAttachments(')
    expect(component).not.toContain("from '../../model/providerIcons'")
    expect(controller).toContain('useAttachments(')
    expect(controller).toContain('normalizeComposerCapabilityInput(')
    expect(controller).toContain("emit('set-permission', mode)")
    expect(controller).toContain("emit('start-goal', content)")
    expect(component.split('\n').length).toBeLessThan(600)
  })

  it('retains the public view contract and explicit Composer surface owner', () => {
    expect(component).toContain('defineExpose(controller.expose)')
    expect(component).toContain(':disabled="sendDisabled"')
    expect(component).toContain('role="dialog"')
    expect(component).toContain('aria-label="模型与思考"')
    expect(composerStyles).toContain('Codex V2 — chat bottom stack + composer')
  })
})
