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
    expect(source).toContain('composer-lifecycle-indicator goal')
    expect(source).toContain('composer-lifecycle-indicator plan')
    expect(source.indexOf('composer-lifecycle-indicator goal')).toBeLessThan(
      source.indexOf('composer-lifecycle-indicator plan'),
    )
    expect(source).toContain("'set-permission': [mode: ControlModeValue]")
    expect(source).not.toContain("'set-mode': [mode: ControlModeValue]")
  })

  it('uses resolved reasoning choices without collapsing xhigh into max', () => {
    expect(source).toContain('currentModel?.reasoningEfforts')
    expect(source).toContain("if (normalized === 'xhigh') return 'XHigh'")
    expect(source).toContain("if (normalized === 'max') return 'Max'")
    expect(source).not.toMatch(/normalized === 'xhigh'.*return 'max'/s)
  })

  it('moves keyboard focus into the model menu and keeps navigation inside it', () => {
    expect(source).toContain('focusModelMenuItem(0)')
    expect(source).toContain("event.key !== 'ArrowDown'")
    expect(source).toContain("event.key !== 'ArrowUp'")
    expect(source).toContain("event.key !== 'Tab'")
    expect(source).toContain('@keydown="onModelMenuKeydown"')
  })
})
