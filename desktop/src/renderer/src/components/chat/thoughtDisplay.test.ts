import { describe, expect, it } from 'vitest'
import type { ThoughtSegment } from '../../types'
import { thoughtPresentation } from './thoughtDisplay'

function thought(extra: Partial<ThoughtSegment> = {}): ThoughtSegment {
  return {
    id: 'thought-1',
    type: 'thought',
    status: 'done',
    durationMs: 0,
    ...extra,
  }
}

describe('thought display helpers', () => {
  it('renders audit summaries as plain text without label or duration prefix', () => {
    const presentation = thoughtPresentation(
      thought({
        label: '思考参考',
        summary: '准备调用 run_command，先通过命令获取运行证据。',
        source: 'audit',
        stage: 'tool_intent',
      }),
    )

    expect(presentation).toEqual({
      kind: 'summary',
      summary: '准备调用 run_command，先通过命令获取运行证据。',
    })
  })

  it('keeps the compact status label for legacy thoughts without summaries', () => {
    const presentation = thoughtPresentation(
      thought({
        label: '整理工具结果',
        durationMs: 2600,
      }),
    )

    expect(presentation).toEqual({
      kind: 'status',
      label: '整理工具结果 · 2.6s',
    })
  })

  it('uses minute-level duration for long thoughts and 0ms placeholder when missing', () => {
    expect(thoughtPresentation(thought({ durationMs: 125_000 }))).toEqual({
      kind: 'status',
      label: '思考了 2m 5s',
    })
    expect(thoughtPresentation(thought({ durationMs: undefined }))).toEqual({
      kind: 'status',
      label: '思考了 0ms',
    })
  })
})
