// UI-S06 card test 8: every title and button of the right 工作台 is
// Chinese. Scans the workbench components' templates — text between tags,
// static and bound (string literal) labels, titles, placeholders,
// descriptions and tooltips — for English words that are not Git or
// product terms.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = new URL('.', import.meta.url).pathname

/** Terms kept in English in the Chinese UI (Git verbs, products, protocols). */
const TERMS = new Set([
  'git',
  'github',
  'gitlab',
  'fetch',
  'pull',
  'push',
  'request',
  'pr',
  'worktree',
  'head',
  'cli',
  'gh',
  'auth',
  'login',
  'shell',
  'url',
  'localhost',
  'http',
  'https',
  'markdown',
  'pdf',
  'mib',
  'emperor',
  'diff',
])

const ATTRIBUTES = [
  'label',
  'title',
  'aria-label',
  'placeholder',
  'description',
  'tooltip',
]

function template(source: string): string {
  const start = source.indexOf('<template>')
  const end = source.lastIndexOf('</template>')
  return start < 0 ? '' : source.slice(start + 10, end)
}

/** String literals inside a template expression. */
function literals(expression: string): string[] {
  return [...expression.matchAll(/'([^']*)'|`([^`]*)`/g)].map((match) =>
    (match[1] ?? match[2] ?? '').replace(/\$\{[^}]*\}/g, ' '),
  )
}

/** A start or end tag, quoted attribute values (which may hold `>`) included. */
const TAG = /<\/?[A-Za-z][^>"']*(?:"[^"]*"[^>"']*|'[^']*'[^>"']*)*>/g

/** Human-facing strings of one template. */
function copyOf(source: string): string[] {
  const markup = template(source).replace(/<!--[\s\S]*?-->/g, '')
  const out: string[] = []
  // Text between tags, with mustaches reduced to their string literals.
  for (const text of markup.split(TAG)) {
    out.push(text.replace(/\{\{([\s\S]*?)\}\}/g, ' '))
    for (const mustache of text.matchAll(/\{\{([\s\S]*?)\}\}/g))
      out.push(...literals(mustache[1]!))
  }
  const tags = [...markup.matchAll(TAG)].map((match) => match[0]).join('\n')
  for (const name of ATTRIBUTES) {
    const statics = new RegExp(`(?<![:@\\w-])${name}="([^"]*)"`, 'g')
    for (const match of tags.matchAll(statics)) out.push(match[1]!)
    const bound = new RegExp(`:${name}="([^"]*)"`, 'g')
    for (const match of tags.matchAll(bound)) out.push(...literals(match[1]!))
  }
  return out
}

function englishWords(text: string): string[] {
  // Example addresses (example.com, localhost:5173) and command flags
  // (`git pull --ff-only` in a tooltip) are not words.
  const prose = text
    .replace(/\b[\w-]+(?:\.[\w-]+)+(?::\d+)?\b/g, ' ')
    .replace(/(?:^|\s)--?[\w-]+/g, ' ')
  return [...prose.matchAll(/[A-Za-z][A-Za-z-]+/g)]
    .map((match) => match[0])
    .filter((word) => !TERMS.has(word.toLowerCase()))
}

/** The workbench components: the panel, its panes and their parts. */
function workbenchComponents(): string[] {
  return readdirSync(DIR).filter(
    (name) =>
      name.endsWith('.vue') &&
      (name.startsWith('Workspace') ||
        name.startsWith('Git') ||
        name.endsWith('Pane.vue') ||
        name === 'TurnReviewView.vue'),
  )
}

describe('工作台 copy (UI-S06 test 8)', () => {
  it('finds the copy of a template', () => {
    expect(
      copyOf(
        `<template><button :label="busy ? 'Stop' : '刷新'" title="Close">Commit {{ n }}</button></template>`,
      ).flatMap(englishWords),
    ).toEqual(['Commit', 'Stop', 'Close'])
  })

  it('scans every workbench component', () => {
    const names = workbenchComponents()
    for (const expected of [
      'WorkspacePanel.vue',
      'GitReviewPane.vue',
      'FilesPane.vue',
      'TerminalPane.vue',
      'BrowserPane.vue',
    ])
      expect(names).toContain(expected)
  })

  it('has no English titles or buttons', () => {
    const offenders: string[] = []
    for (const name of workbenchComponents()) {
      const words = copyOf(readFileSync(join(DIR, name), 'utf8')).flatMap(
        englishWords,
      )
      if (words.length) offenders.push(`${name}: ${[...new Set(words)]}`)
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})
