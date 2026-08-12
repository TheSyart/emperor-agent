import { describe, expect, it } from 'vitest'
import {
  CommandParseError,
  parseCommandInput,
  tokenizeCommandInput,
} from './parser'

describe('command parser', () => {
  it('only treats a leading slash command token as a command', () => {
    expect(parseCommandInput('请打开 /model')).toBeNull()
    expect(parseCommandInput('/Users/anhuike/project')).toBeNull()
    expect(parseCommandInput('/model')).toMatchObject({
      name: 'model',
      args: [],
    })
  })

  it('tokenizes quotes, escaped whitespace, options and the option terminator deterministically', () => {
    expect(
      tokenizeCommandInput(
        String.raw`/compact "日报 1.md" --format=markdown --flag path\ with\ spaces -- --literal`,
      ),
    ).toEqual([
      '/compact',
      '日报 1.md',
      '--format=markdown',
      '--flag',
      'path with spaces',
      '--',
      '--literal',
    ])

    expect(
      parseCommandInput(
        String.raw`/compact "日报 1.md" --format=markdown --flag -- --literal`,
      ),
    ).toMatchObject({
      name: 'compact',
      args: ['日报 1.md', '--literal'],
      options: { format: 'markdown', flag: true },
    })
  })

  it('rejects unterminated quotes and never performs shell expansion', () => {
    expect(() => tokenizeCommandInput(`/goal "unfinished`)).toThrow(
      CommandParseError,
    )
    expect(parseCommandInput('/goal $(whoami)')?.args).toEqual(['$(whoami)'])
  })
})
