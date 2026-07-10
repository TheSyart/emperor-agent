import { describe, expect, it } from 'vitest'
import {
  appendSectionItem,
  canonicalSections,
  replaceSection,
} from './markdown-schema'

describe('memory markdown schema', () => {
  it('defines canonical sections for each memory kind', () => {
    expect(canonicalSections('user_profile')).toEqual(
      expect.arrayContaining([
        '基本信息',
        '偏好设置',
        '工作背景',
        'Stable Preferences',
        'Working Style',
        'Long-Term Constraints',
        'Deprecated',
      ]),
    )
    expect(canonicalSections('global')).toContain('Cross-Project Decisions')
    expect(canonicalSections('project')).toContain('Build Commands')
    expect(canonicalSections('episode')).toContain('Raw References')
  })

  it('appends an item to an existing section without touching unrelated content', () => {
    const input = [
      '# User Profile',
      '',
      'Intro comment that must stay.',
      '',
      '## Stable Preferences',
      '- existing preference',
      '',
      '## Working Style',
      '- existing style',
      '',
      '## Deprecated',
      '- old item',
      '',
    ].join('\n')

    const output = appendSectionItem(
      input,
      'Stable Preferences',
      '- new stable preference',
    )

    expect(output).toContain('Intro comment that must stay.')
    expect(output).toContain('## Working Style\n- existing style')
    expect(output).toContain(
      '## Stable Preferences\n- existing preference\n- new stable preference',
    )
    expect(output).toContain('## Deprecated\n- old item')
  })

  it('creates a missing canonical section at the end while preserving the original document', () => {
    const output = appendSectionItem(
      '# Project Memory\n\n## Project Identity\n- Emperor\n',
      'Known Issues',
      '- flaky compaction',
    )

    expect(output).toContain('## Project Identity\n- Emperor')
    expect(output.trimEnd()).toMatch(/## Known Issues\n- flaky compaction$/)
  })

  it('replaces only the target section body', () => {
    const input =
      '# Global Long-Term Memory\n\n## Long-Term Projects\n- A\n\n## Open Questions\n- Q\n'

    const output = replaceSection(input, 'Long-Term Projects', '- B')

    expect(output).toContain('## Long-Term Projects\n- B')
    expect(output).toContain('## Open Questions\n- Q')
    expect(output).not.toContain('- A')
  })
})
