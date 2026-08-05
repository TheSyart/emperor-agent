import { describe, expect, it } from 'vitest'
import {
  CommandParseError,
  parseCommandInput,
  tokenizeCommandInput,
} from './parser'

describe('command parser', () => {
  it('only treats a leading slash command token as a command', () => {
    expect(parseCommandInput('请打开 /help')).toBeNull()
    expect(parseCommandInput('/Users/anhuike/project')).toBeNull()
    expect(parseCommandInput('/help')).toMatchObject({ name: 'help', args: [] })
  })

  it('tokenizes quotes, escaped whitespace, options and the option terminator deterministically', () => {
    expect(
      tokenizeCommandInput(
        String.raw`/export "日报 1.md" --format=markdown --flag path\ with\ spaces -- --literal`,
      ),
    ).toEqual([
      '/export',
      '日报 1.md',
      '--format=markdown',
      '--flag',
      'path with spaces',
      '--',
      '--literal',
    ])

    expect(
      parseCommandInput(
        String.raw`/export "日报 1.md" --format=markdown --flag -- --literal`,
      ),
    ).toMatchObject({
      name: 'export',
      args: ['日报 1.md', '--literal'],
      options: { format: 'markdown', flag: true },
    })
  })

  it('rejects unterminated quotes and never performs shell expansion', () => {
    expect(() => tokenizeCommandInput(`/rename "unfinished`)).toThrow(
      CommandParseError,
    )
    expect(parseCommandInput('/rename $(whoami)')?.args).toEqual(['$(whoami)'])
  })
})
