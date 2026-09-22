import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(join(__dirname, path), 'utf8')
const card = read('ComposerCard.vue')
const controller = read('../chat/composerController.ts')
const model = read('ModelPicker.vue')

describe('ComposerCard controller/view ownership', () => {
  it('keeps stateful behaviour in the shared controller and the SFC as a view', () => {
    expect(card).toContain('useComposerController(props, emit)')
    expect(card).not.toContain('useAttachments(')
    expect(controller).toContain('useAttachments(')
    expect(controller).toContain('normalizeComposerCapabilityInput(')
    expect(controller).toContain("emit('set-permission', mode)")
    expect(controller).toContain("emit('start-goal', content)")
    expect(controller).toContain('Goal Outcome 暂仅支持纯文字')
    expect(controller).toContain('uploading.value.size > 0')
  })

  it('retains the public view contract', () => {
    expect(card).toContain('defineExpose(controller.expose)')
    expect(card).toContain(':disabled="sendDisabled"')
    expect(card).toContain('<PermissionChip')
    expect(card).toContain('<PlanChip')
    expect(card).toContain('<ModelPicker')
    expect(card).toContain('<ContextMeter')
    expect(card).toContain("emit('dismiss-lifecycle')")
    expect(card).toContain("emit('activate-plan')")
    expect(card).toContain("emit('activate-goal')")
  })

  it('switches models by entry id and keeps reasoning choices distinct', () => {
    expect(model).toContain("emit('select-model', entry.entryId)")
    expect(model).toContain('entry.entryId === activeId')
    expect(controller).toContain('currentModel?.reasoningEfforts')
    expect(controller).toContain("if (normalized === 'xhigh') return 'XHigh'")
    expect(controller).toContain("if (normalized === 'max') return 'Max'")
  })

  it('caps the draft at the dsh 14-line height', () => {
    expect(controller).toContain('COMPOSER_TEXT_MAX_HEIGHT = 336')
  })
})
