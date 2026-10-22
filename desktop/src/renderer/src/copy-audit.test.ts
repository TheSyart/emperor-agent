import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  auditScript,
  auditVue,
  bannedTermsIn,
  isUntranslated,
  type CopyFinding,
} from './copyAudit'

// UI-S10 (UI-37): the interface speaks Chinese and uses the terms of
// docs/design/writing.md. Development galleries and test fixtures are not
// user-facing and are left out.

const SRC = new URL('.', import.meta.url).pathname
const SKIPPED = [
  /\.test\.ts$/,
  /\.d\.ts$/,
  /(^|\/)testing\//,
  /(^|\/)gallery\//,
  /Gallery(Components)?\.vue$/,
  /copyAudit\.ts$/,
]

function sources(root = SRC, dir = root): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...sources(root, path))
    else if (/\.(vue|ts)$/.test(entry)) {
      const rel = relative(root, path)
      if (!SKIPPED.some((pattern) => pattern.test(rel))) out.push(rel)
    }
  }
  return out
}

function scan(): CopyFinding[] {
  return sources().flatMap((rel) => {
    const source = readFileSync(join(SRC, rel), 'utf8')
    return rel.endsWith('.vue')
      ? auditVue(rel, source)
      : auditScript(rel, source)
  })
}

const findings = scan()

// Core's messages reach the interface through IPC (errors, notices, labels):
// they use the same terms. English stays allowed there (the model reads it).
const CORE = new URL('../../../../packages/core/src/', import.meta.url).pathname
const coreBanned = sources(CORE)
  .flatMap((rel) => auditScript(rel, readFileSync(join(CORE, rel), 'utf8')))
  .filter((finding) => finding.kind === 'banned')
const of = (kind: CopyFinding['kind']) =>
  findings.filter((finding) => finding.kind === kind)
const listing = (items: CopyFinding[]) =>
  items.map((item) => `${item.file} (${item.where}): ${item.text}`).join('\n')

describe('copy audit (UI-S10)', () => {
  it('1 · 8 · no untranslated English in the interface', () => {
    expect(listing(of('english'))).toBe('')
  })

  it('3 · 8 · no retired term (子代理, 执行器, 派工, 验收, 结果树)', () => {
    expect(listing(of('banned'))).toBe('')
  })

  it('3 · Core messages shown through IPC use the same terms', () => {
    expect(listing(coreBanned)).toBe('')
  })

  it('2 · a new English button label fails the audit', () => {
    const found = auditVue(
      'Fixture.vue',
      '<template><Button>Save changes</Button><Button title="Open the file">打开</Button></template>',
    )
    expect(found.map((item) => [item.where, item.text])).toEqual([
      ['text', 'Save changes'],
      ['title', 'Open the file'],
    ])
    expect(
      auditScript(
        'fixture.ts',
        "const items = [{ label: 'Fetch' }, { label: `Request #${n}` }]\nfunction stateLabel() { return 'Running' }",
      ).map((item) => item.text),
    ).toEqual(['Fetch', 'Request #', 'Running'])
    // Bound attributes and interpolations: the strings they can show.
    expect(
      auditVue(
        'Fixture.vue',
        `<template><Button :title="open ? 'Collapse turns' : '展开'">{{ busy ? '加载中' : 'Load more' }}</Button><Badge :tone="state === 'running' ? 'ok' : 'warn'" /></template>`,
      ).map((item) => [item.where, item.text]),
    ).toEqual([
      [':title', 'Collapse turns'],
      ['text', 'Load more'],
    ])
    expect(
      auditScript(
        'fixture.ts',
        "const kindLabel = (kind: string) => kind === 'user' ? '用户' : 'Unknown'",
      ).map((item) => item.text),
    ).toEqual(['Unknown'])
  })

  it('FIX-09 · 5 · English behind `as const`, in a titles map or table, a `label` computed and a meta key fails too', () => {
    expect(
      auditScript(
        'fixture.ts',
        [
          "const groups = [{ label: 'Commands' as const }, { label: 'Run tests' satisfies string }]",
          "const BUILTIN_TITLES = new Map<string, string>([['new', 'New chat'], ['plan', '计划模式']])",
          "const STEP_TITLE: Record<string, string> = { read: 'Read file', write: '写入' }",
          "const label = computed(() => (mode === 'goal' ? 'Goal' : 'Plan'))",
          "const item = { meta: tags || 'Project Skill', tags: source === 'user' ? 'User Skill' : '' }",
          // Not shown: keys, comparisons, ids.
          "const ids = new Map([['Commands', 1]]); const kind = mode === 'Plan' ? 1 : 2",
        ].join('\n'),
      ).map((item) => item.text),
    ).toEqual([
      'Commands',
      'Run tests',
      'New chat',
      'Read file',
      'Goal',
      'Plan',
      'Project Skill',
      'User Skill',
    ])
  })

  it('3 · a retired term fails the audit', () => {
    expect(bannedTermsIn('等待执行器输出…')).toEqual(['执行器'])
    expect(
      auditVue(
        'Fixture.vue',
        '<template><p>返回主会话继续派工</p></template>',
      ).map((item) => item.kind),
    ).toEqual(['banned'])
  })

  it('keeps brand names, commands, files, URLs and code as they are', () => {
    for (const text of [
      'GitHub',
      'Claude Code',
      'API Key',
      'mcp_config.json',
      'https://example.com',
      'SKILL.md',
      'HTTPS_PROXY',
      'owner/repo',
      '已连接 · 2 个工具',
      'Emperor Agent',
      'Emperor Computer Helper 未连接',
      'Emperor Computer Helper',
      'GitHub Pull Requests',
      'com.example.Writer | EXAMPLE123 |',
      'git pull --ff-only',
      'gh auth login',
    ])
      expect(isUntranslated(text), text).toBe(false)
    expect(
      auditVue(
        'Fixture.vue',
        '<template><code>gh auth login</code><kbd>Esc</kbd><TextField monospace placeholder="npx" /><Badge mono>exit 0</Badge></template>',
      ),
    ).toEqual([])
    // A plain field's placeholder is still prose.
    expect(
      auditVue(
        'Fixture.vue',
        '<template><TextField placeholder="Search tools" /></template>',
      ).map((item) => item.text),
    ).toEqual(['Search tools'])
    for (const text of [
      'Usage not reported',
      'Loading trajectory…',
      'Fetch',
      'git is not installed',
    ])
      expect(isUntranslated(text), text).toBe(true)
  })
})
