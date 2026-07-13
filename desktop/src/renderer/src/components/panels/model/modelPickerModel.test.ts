import { describe, expect, it } from 'vitest'
import type { DiscoveredModel, ModelEntry } from '../../../types'
import {
  applyModelSelection,
  computeModelPickerPlacement,
  filterModelOptions,
  normalizeModelOptions,
} from './modelPickerModel'

const discovered: DiscoveredModel[] = [
  { id: 'deepseek-chat', ownedBy: 'DeepSeek' },
  { id: 'deepseek-reasoner', ownedBy: 'DeepSeek' },
  { id: 'qwen-plus', ownedBy: 'Alibaba Cloud' },
]

describe('model picker model', () => {
  it('deduplicates candidates by trimmed id while preserving backend order', () => {
    expect(
      normalizeModelOptions([
        discovered[0],
        { id: ' deepseek-chat ', ownedBy: 'duplicate' },
        discovered[2],
      ]),
    ).toEqual([discovered[0], discovered[2]])
  })

  it('returns every candidate when the picker reopens with an empty query', () => {
    const options = normalizeModelOptions(discovered, 'deepseek-chat')

    expect(filterModelOptions(options, '')).toEqual(discovered)
  })

  it('filters model id and owner case-insensitively', () => {
    const options = normalizeModelOptions(discovered)

    expect(filterModelOptions(options, 'REASON')).toEqual([discovered[1]])
    expect(filterModelOptions(options, 'alibaba')).toEqual([discovered[2]])
  })

  it('does not let the current custom value hide the no-match state while typing', () => {
    const options = normalizeModelOptions(discovered, 'missing-model')

    expect(filterModelOptions(options, 'missing')).toEqual([])
  })

  it('keeps a custom current id available without mutating discovered options', () => {
    expect(normalizeModelOptions(discovered, 'private-model-v1')).toEqual([
      { id: 'private-model-v1', custom: true },
      ...discovered,
    ])
    expect(discovered).toHaveLength(3)
  })

  it('syncs the legacy id only for the main model selection', () => {
    const entry: ModelEntry = {
      name: 'primary',
      provider: 'deepseek',
      id: 'old-main',
      mainModelId: 'old-main',
      secondaryModelId: 'old-secondary',
    }

    expect(applyModelSelection(entry, 'main', 'deepseek-chat')).toEqual({
      ...entry,
      id: 'deepseek-chat',
      mainModelId: 'deepseek-chat',
    })
    expect(
      applyModelSelection(entry, 'secondary', 'deepseek-reasoner'),
    ).toEqual({
      ...entry,
      secondaryModelId: 'deepseek-reasoner',
    })
  })

  it('anchors a short popover immediately above the input using its rendered height', () => {
    expect(
      computeModelPickerPlacement({
        anchor: { left: 420, top: 690, right: 720, bottom: 730, width: 300 },
        contentHeight: 88,
        viewportWidth: 1024,
        viewportHeight: 768,
      }),
    ).toMatchObject({
      placement: 'top',
      top: 596,
      left: 420,
      width: 300,
      maxHeight: 88,
    })
  })

  it('keeps the popover adjacent while constraining it to narrow viewport space', () => {
    expect(
      computeModelPickerPlacement({
        anchor: { left: -4, top: 300, right: 396, bottom: 340, width: 400 },
        contentHeight: 420,
        viewportWidth: 390,
        viewportHeight: 500,
      }),
    ).toEqual({
      placement: 'top',
      top: 34,
      left: 8,
      width: 374,
      maxHeight: 260,
    })
  })
})
