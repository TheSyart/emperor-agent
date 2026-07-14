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

  it('uses resolved reasoning choices without collapsing xhigh into max', () => {
    expect(source).toContain('currentModel?.reasoningEfforts')
    expect(source).toContain("if (normalized === 'xhigh') return 'XHigh'")
    expect(source).toContain("if (normalized === 'max') return 'Max'")
    expect(source).not.toMatch(/normalized === 'xhigh'.*return 'max'/s)
  })
})
