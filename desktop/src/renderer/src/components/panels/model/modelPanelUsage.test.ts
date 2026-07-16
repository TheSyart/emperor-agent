import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const panelSource = readFileSync(
  join(__dirname, '..', 'ModelPanel.vue'),
  'utf8',
)
const listSource = readFileSync(join(__dirname, 'ModelEntryList.vue'), 'utf8')

describe('single-model settings information architecture', () => {
  it('uses a model list and accessible shared add/edit dialog', () => {
    expect(panelSource).toContain('model-editor-dialog')
    expect(panelSource).toContain('role="dialog"')
    expect(panelSource).toContain('aria-modal="true"')
    expect(listSource).toContain('model-entry-list')
    expect(listSource).toContain('providerIconAsset')
    expect(listSource).toContain('编辑')
    expect(listSource).toContain('删除')
    expect(listSource).not.toContain('设为激活')
    expect(listSource).not.toContain('active-badge')
    expect(listSource).not.toContain('activatingId')
  })

  it('exposes only the two standard protocols and the required model controls', () => {
    expect(panelSource).toContain('OpenAI Chat Completions')
    expect(panelSource).toContain('Anthropic Messages')
    expect(panelSource).toContain('获取模型')
    expect(panelSource).toContain('工具调用')
    expect(panelSource).toContain('图片输入')
    expect(panelSource).toContain('思考模式')
    expect(panelSource).toContain('自动识别')
    expect(panelSource).toContain('[32_000, 64_000, 128_000, 256_000]')
    expect(panelSource).toContain('[8_000, 16_000, 32_000, 64_000]')
    expect(panelSource).toContain('formatTokenPreset')
  })

  it('does not expose retired routing or unsafe expert fields', () => {
    for (const retired of [
      'secondaryModelId',
      '主次模型',
      '测试主模型',
      '测试次模型',
      'Temperature',
      'Extra JSON',
      '自定义协议',
    ]) {
      expect(panelSource).not.toContain(retired)
      expect(listSource).not.toContain(retired)
    }
    expect(panelSource).toContain('saveModelEntry')
    expect(panelSource).not.toContain('activateModelEntry')
    expect(panelSource).not.toContain('单模型运行')
    expect(panelSource).not.toContain('当前激活模型')
    expect(panelSource).not.toContain('ModelConfigRaw')
  })
})
