// KRN-07: DeepSeek has no medium effort; the composer says so under High.
import { describe, expect, it } from 'vitest'
import type { CurrentModelConfig } from '../../types'
import { useComposerModelControl } from './composerModelControl'

function control(current: Partial<CurrentModelConfig>) {
  return useComposerModelControl(
    {
      busy: false,
      control: null,
      currentModel: {
        entryId: 'main',
        provider: 'deepseek',
        reasoningEffort: null,
        reasoningEfforts: ['low', 'high', 'max'],
        ...current,
      } as CurrentModelConfig,
      modelEntries: [],
    },
    () => {},
    () => {},
  )
}

describe('composer effort options', () => {
  it('notes that Medium is sent as High on DeepSeek', () => {
    const options = control({}).reasoningOptions.value
    expect(options.map((option) => option.value)).toEqual([
      null,
      'low',
      'high',
      'max',
    ])
    expect(options.find((option) => option.value === 'high')).toMatchObject({
      description: 'Medium 也按 High 发送',
    })
    expect(
      options.filter((option) => 'description' in option && option.description),
    ).toHaveLength(1)
  })

  it('adds no note for other providers', () => {
    const options = control({
      provider: 'openai',
      reasoningEfforts: ['low', 'medium', 'high'],
    }).reasoningOptions.value
    expect(options.some((option) => 'description' in option)).toBe(false)
  })
})
