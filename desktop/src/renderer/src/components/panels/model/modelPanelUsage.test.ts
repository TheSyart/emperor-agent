import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(__dirname, '..', 'ModelPanel.vue'), 'utf8')

describe('model settings information architecture', () => {
  it('places the main and secondary model guide after advanced settings and before save', () => {
    const advancedIndex = source.indexOf('class="advanced-panel"')
    const guideIndex = source.indexOf('class="model-role-guide"')
    const saveIndex = source.indexOf('class="model-action-bar"')

    expect(advancedIndex).toBeGreaterThan(-1)
    expect(guideIndex).toBeGreaterThan(advancedIndex)
    expect(saveIndex).toBeGreaterThan(guideIndex)
    expect(source).toContain('主次模型怎么选')
    expect(source).toContain('主 Agent、复杂决策')
    expect(source).toContain('记忆压缩、轻量只读')
    expect(source).toMatch(/可选择同一个 Model\s+ID/)
  })
})
