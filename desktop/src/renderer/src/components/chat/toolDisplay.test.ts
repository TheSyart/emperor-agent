import { describe, expect, it } from 'vitest'
import type { ToolSegment } from '../../types'
import {
  durationLabel,
  fullOutputRef,
  toolStatusText,
  toolTargetLabel,
  toolTitle,
} from './toolDisplay'

function tool(name: string, extra: Partial<ToolSegment> = {}): ToolSegment {
  return {
    id: 'tool-1',
    type: 'tool',
    name,
    status: 'done',
    ...extra,
  }
}

describe('tool display helpers', () => {
  it('prefers result metadata path over call arguments for file tools', () => {
    expect(
      toolTitle(
        tool('read_file', {
          arguments: { path: 'stale/path.ts' },
          metadata: { path: 'src/current/path.ts' },
        }),
      ),
    ).toBe('Read · path.ts')
  })

  it('uses the final file name for file tool targets', () => {
    expect(
      toolTitle(
        tool('read_file', {
          arguments: { path: '/a/b/mario/js/collision.js' },
        }),
      ),
    ).toBe('Read · collision.js')
    expect(
      toolTitle(
        tool('edit_file', {
          metadata: { path: 'desktop/src/renderer/src/App.vue' },
        }),
      ),
    ).toBe('Edit · App.vue')
  })

  it('keeps bash titles generic while other non-file tools show targets', () => {
    expect(
      toolTitle(tool('glob', { arguments: { pattern: 'src/**/*.vue' } })),
    ).toBe('Glob · src/**/*.vue')
    expect(
      toolTitle(
        tool('grep', { arguments: { pattern: 'projectAssistantFlow' } }),
      ),
    ).toBe('Search · projectAssistantFlow')
    expect(
      toolTitle(
        tool('run_command', {
          arguments: { command: 'npm run build -- --mode production' },
        }),
      ),
    ).toBe('Bash · 执行命令')
  })

  it('shortens long non-file targets while preserving useful tail content', () => {
    const label = toolTargetLabel(
      tool('edit_file', {
        arguments: {
          path: '/Users/anhuike/Documents/workspace/emperor-agent/desktop/src/renderer/src/components/chat/ToolGroup.vue',
        },
      }),
    )

    expect(label).toBe('ToolGroup.vue')

    const url = toolTargetLabel(
      tool('web_fetch', {
        arguments: {
          url: 'https://example.com/docs/some/really/long/path/that/keeps/going/reference.html',
        },
      }),
    )

    expect(url).toBe('.../that/keeps/going/reference.html')
  })
})

describe('fullOutputRef (Wave3.1)', () => {
  it('returns the persisted ref only for truncated outputs that carry one', () => {
    expect(
      fullOutputRef(
        tool('run_command', {
          outputTruncated: true,
          metadata: { full_output_ref: 'memory/tool-results/abc.txt' },
        }),
      ),
    ).toBe('memory/tool-results/abc.txt')

    expect(
      fullOutputRef(
        tool('run_command', {
          outputTruncated: false,
          metadata: { full_output_ref: 'memory/tool-results/abc.txt' },
        }),
      ),
    ).toBe('')

    expect(fullOutputRef(tool('run_command', { outputTruncated: true }))).toBe(
      '',
    )
  })
})

describe('toolStatusText (Wave4.2)', () => {
  it('labels each tool status distinctly, including queued', () => {
    expect(toolStatusText('queued')).toBe('排队中')
    expect(toolStatusText('running')).toBe('执行中')
    expect(toolStatusText('done')).toBe('完成')
    expect(toolStatusText('error')).toBe('出错')
    expect(toolStatusText('error_aborted')).toBe('已中断')
  })
})

describe('durationLabel', () => {
  it('formats sub-second, seconds, minute, and hour tiers', () => {
    expect(durationLabel(undefined)).toBe('')
    expect(durationLabel(0)).toBe('0ms')
    expect(durationLabel(420)).toBe('420ms')
    expect(durationLabel(1500)).toBe('1.5s')
    expect(durationLabel(9_999)).toBe('10.0s')
    expect(durationLabel(12_000)).toBe('12s')
    expect(durationLabel(59_500)).toBe('60s')
    expect(durationLabel(830_000)).toBe('13m 50s')
    expect(durationLabel(866_000)).toBe('14m 26s')
    expect(durationLabel(3_900_000)).toBe('1h 5m')
  })
})
