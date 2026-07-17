import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(__dirname, 'Composer.vue'), 'utf8')

describe('Composer single-model controls', () => {
  it('switches by entry id and displays only one model id', () => {
    expect(source).toContain("'switch-model': [entryId: string]")
    expect(source).toContain('entry.entryId === activeModelId')
    expect(source).toContain("entry.modelId || '未配置'")
    expect(source).not.toContain('mainModelId')
    expect(source).not.toContain('secondaryModelId')
  })

  it('uses shared Provider logos and separates the current model from alternatives', () => {
    expect(source).toContain("from '../../model/providerIcons'")
    expect(source).toContain('providerIconAsset')
    expect(source).toContain('providerIconFallback')
    expect(source).toContain('当前模型')
    expect(source).toContain('otherModelEntries')
    expect(source).not.toContain(':is="modelIcons.text"')
  })

  it('shows Goal then Plan as independent lifecycle indicators', () => {
    expect(source).toContain('ComposerLifecycleIndicator')
    expect(source).toContain('kind="goal"')
    expect(source).toContain('kind="plan"')
    expect(source.indexOf('kind="goal"')).toBeLessThan(
      source.indexOf('kind="plan"'),
    )
    expect(source).toContain('@dismiss="emit(\'cancel-goal\')"')
    expect(source).toContain('@dismiss="emit(\'exit-plan\')"')
    expect(source).toContain('v-if="goalActive || planActive"')
    expect(source).toContain("'set-permission': [mode: ControlModeValue]")
    expect(source).not.toContain("'set-mode': [mode: ControlModeValue]")
  })

  it('activates lifecycle palette items without inserting command usage', () => {
    expect(source).toContain("'activate-plan': []")
    expect(source).toContain("'activate-goal': []")
    expect(source).toContain("item.action === 'activate_plan'")
    expect(source).toContain("item.action === 'activate_goal'")
    expect(source).toContain("emit('activate-plan')")
    expect(source).toContain("emit('activate-goal')")
  })

  it('keeps Goal capture text-only without losing reactive upload state', () => {
    expect(source).toContain('uploading.value.size > 0')
    expect(source).toContain("emit('start-goal', content)")
    expect(source).toContain('Goal Outcome 暂仅支持纯文字')
  })

  it('uses resolved reasoning choices without collapsing xhigh into max', () => {
    expect(source).toContain('currentModel?.reasoningEfforts')
    expect(source).toContain("if (normalized === 'xhigh') return 'XHigh'")
    expect(source).toContain("if (normalized === 'max') return 'Max'")
    expect(source).not.toMatch(/normalized === 'xhigh'.*return 'max'/s)
  })

  it('keeps the collapsed model trigger limited to logo, name, and caret', () => {
    const trigger = source.match(
      /<button\s+ref="modelButton"[\s\S]*?<\/button>/,
    )?.[0]

    expect(trigger).toContain('model-provider-avatar bare')
    expect(trigger).toContain('model-provider-mask')
    expect(trigger).toContain('model-button-label')
    expect(trigger).toContain('actionIcons.caretDown')
    expect(trigger).not.toContain('model-button-meta')
    expect(trigger).not.toContain('model-button-separator')
  })

  it('moves keyboard focus into the model menu and keeps navigation inside it', () => {
    expect(source).toContain('focusModelMenuItem(0)')
    expect(source).toContain("event.key !== 'ArrowDown'")
    expect(source).toContain("event.key !== 'ArrowUp'")
    expect(source).toContain("event.key !== 'Tab'")
    expect(source).toContain('@keydown="onModelMenuKeydown"')
  })
})
