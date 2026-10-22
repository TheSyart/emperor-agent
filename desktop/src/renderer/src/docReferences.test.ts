import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// REL-06: what the public docs refer to must exist. The checks live in
// scripts/lib/doc-references.mjs and run in ./scripts/check.sh through
// scripts/check_public_docs.mjs; here each one is shown a broken reference.

const REPO = join(new URL('.', import.meta.url).pathname, '../../../..')

interface SettingsSection {
  key: string
  files: string[]
  names: Set<string>
}
interface Navigation {
  sections: Map<string, SettingsSection>
}
interface DocReferences {
  settingsNavigation: (root: string) => Navigation
  settingsPathProblems: (
    source: string,
    navigation: Navigation,
    file?: string,
  ) => string[]
  coreOperations: (root: string) => Set<string>
  coreOperationProblems: (
    source: string,
    operations: Set<string>,
    file?: string,
  ) => string[]
  privateReferenceProblems: (source: string, file?: string) => string[]
  verificationOf: (
    source: string,
  ) => { date: string; commit: string | null } | null
  comparableText: (source: string) => string
  verificationProblems: (
    root: string,
    files: string[],
    today?: string,
  ) => string[]
  currentChangelog: (source: string) => string
  checkDocReferences: (root: string) => Record<string, string[]>
}

async function load(): Promise<DocReferences> {
  const url = pathToFileURL(join(REPO, 'scripts/lib/doc-references.mjs')).href
  return (await import(/* @vite-ignore */ url)) as DocReferences
}

describe('settings paths in the docs (test 2)', () => {
  let lib: DocReferences
  let navigation: Navigation
  beforeAll(async () => {
    lib = await load()
    navigation = lib.settingsNavigation(REPO)
  })

  it('reads the nine sections and the names in their components', () => {
    expect([...navigation.sections.keys()]).toEqual([
      '常规',
      '模型',
      '子智能体',
      '记忆',
      '电脑操作',
      '浏览器',
      '语音',
      '用量',
      '高级',
    ])
    const advanced = navigation.sections.get('高级')!
    for (const name of ['网络工具', '任务预算', '诊断', '存储', '备份与恢复'])
      expect(advanced.names.has(name), name).toBe(true)
    expect(navigation.sections.get('子智能体')!.names.has('开发环境')).toBe(
      true,
    )
  })

  it('accepts paths that exist and skips macOS 系统设置', () => {
    const doc = [
      '在「设置 › 子智能体 › 高级 › 开发环境」里打开。',
      '「设置 › 常规 › 开发者 › 显示轨迹」',
      '「设置 › 高级 › 存储 › 备份与恢复」',
      '到「系统设置 › 隐私与安全性」点「仍要打开」。',
      '菜单栏「Emperor Agent › 偏好设置…」',
    ].join('\n')
    expect(lib.settingsPathProblems(doc, navigation, 'doc.md')).toEqual([])
  })

  it('fails a path to a page that does not exist', () => {
    expect(
      lib.settingsPathProblems(
        '「设置 › 子智能体 › 不存在的页」',
        navigation,
        'doc.md',
      ),
    ).toEqual([
      'doc.md:1: 「设置 › 子智能体 › 不存在的页」 「子智能体」里没有「不存在的页」',
    ])
  })

  it('fails a section that is a sub page now, an arrow and a missing 「」', () => {
    expect(
      lib.settingsPathProblems('「设置 › 诊断 › 进程隔离回执」', navigation),
    ).toEqual([expect.stringContaining('「诊断」不是设置分区')])
    expect(
      lib.settingsPathProblems('“设置 → 高级 → Hooks”', navigation),
    ).toEqual([
      expect.stringContaining('用 › 分隔，不用 →'),
      expect.stringContaining('放在「」里'),
    ])
    expect(
      lib.settingsPathProblems('在设置 › 电脑操作中确认', navigation),
    ).not.toEqual([])
  })
})

describe('Core operations in the docs (test 3)', () => {
  let lib: DocReferences
  let operations: Set<string>
  beforeAll(async () => {
    lib = await load()
    operations = lib.coreOperations(REPO)
  })

  it('reads the registry', () => {
    expect(operations.size).toBeGreaterThan(200)
    for (const key of ['agents.send', 'delegations.abandon', 'storage.usage'])
      expect(operations.has(key), key).toBe(true)
  })

  it('accepts real operations, slash lists and file names', () => {
    const doc = [
      '`agents.send({ sessionId, text })` 给子智能体发消息。',
      '`executors.list/probe/models/configure`',
      '配置在 `config.json` 与 `hooks.json`，旧会话在 `sessions.legacy-<时间戳>/`，发布在 `github.com`。',
      '`delegations.*` 都要求根会话。',
      '旧的 `skills.package` 已从注册表移除。',
    ].join('\n')
    expect(lib.coreOperationProblems(doc, operations, 'doc.md')).toEqual([])
  })

  it('fails an operation that does not exist', () => {
    expect(
      lib.coreOperationProblems(
        'renderer 调用 `agents.sendd` 与 `delegations.stopAll`。',
        operations,
        'doc.md',
      ),
    ).toEqual([
      expect.stringContaining('`agents.sendd` 不是 Core 操作'),
      expect.stringContaining('`delegations.stopAll` 不是 Core 操作'),
    ])
  })

  it('fails a removed operation named as if it still existed', () => {
    expect(
      lib.coreOperationProblems(
        '用 `computerUse.stop` 停下。',
        operations,
        'doc.md',
      ),
    ).toEqual([expect.stringContaining('`computerUse.stop`')])
  })
})

describe('private material (test 7)', () => {
  it('fails links and paths into private-docs/, not the folder name', async () => {
    const lib = await load()
    expect(
      lib.privateReferenceProblems(
        '个人材料放在 `private-docs/`，不加入公共导航。',
      ),
    ).toEqual([])
    expect(
      lib.privateReferenceProblems(
        [
          '[计划](../../private-docs/progress/plan.md)',
          '<a href="https://github.com/o/r/blob/main/private-docs/a.md">a</a>',
          '见 `private-docs/progress/2026-10-18/plan.md`',
        ].join('\n'),
        'doc.md',
      ),
    ).toEqual([
      expect.stringContaining('doc.md:1: 链接到私有材料'),
      expect.stringContaining('doc.md:1: 写出了私有材料里的路径'),
      expect.stringContaining('doc.md:2: 链接到私有材料'),
      expect.stringContaining('doc.md:2: 写出了私有材料里的路径'),
      expect.stringContaining('doc.md:3: 写出了私有材料里的路径'),
    ])
  })
})

describe('最后核验 (test 6)', () => {
  let lib: DocReferences
  let repo: string
  const git = (args: string[], date = '2026-10-21T12:00:00') =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args],
      {
        cwd: repo,
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        },
        stdio: 'pipe',
        encoding: 'utf8',
      },
    )
  const page = (verified: string, body: string) =>
    [
      '# 页面',
      '',
      '> 文档状态：Active<br>',
      '> 面向读者：用户<br>',
      `> 最后核验：${verified}<br>`,
      '> 事实源：`src/`',
      '',
      body,
      '',
    ].join('\n')
  const write = (verified: string, body: string) =>
    writeFileSync(join(repo, 'docs/page.md'), page(verified, body))
  const commit = (message: string, date: string) => {
    git(['add', '-A'], date)
    git(['commit', '-q', '-m', message], date)
  }

  beforeAll(async () => {
    lib = await load()
    repo = mkdtempSync(join(tmpdir(), 'emperor-docs-verified-'))
    mkdirSync(join(repo, 'docs'))
    git(['init', '-q'])
  })
  afterAll(() => rmSync(repo, { recursive: true, force: true }))

  it('reads the date and the commit it was checked against', () => {
    expect(
      lib.verificationOf(page('2026-10-21（对照 `ce55ee4a`）', '正文')),
    ).toEqual({ date: '2026-10-21', commit: 'ce55ee4a' })
    expect(lib.verificationOf(page('2026-10-20', '正文'))).toEqual({
      date: '2026-10-20',
      commit: null,
    })
  })

  it('does not count re-aligned tables or the date line as a change', () => {
    const narrow = '| a | b |\n| - | - |\n| 1 | 2 |'
    const wide = '| a   | b   |\n| --- | --- |\n| 1   | 2   |'
    expect(lib.comparableText(page('2026-10-01', narrow))).toBe(
      lib.comparableText(page('2026-10-21', wide)),
    )
    expect(lib.comparableText(page('2026-10-01', '旧'))).not.toBe(
      lib.comparableText(page('2026-10-01', '新')),
    )
  })

  it('fails text changed after its 最后核验, and passes once it is checked again', () => {
    write('2026-10-19', '第一版')
    commit('first', '2026-10-19T09:00:00')
    expect(
      lib.verificationProblems(repo, ['docs/page.md'], '2026-10-21'),
    ).toEqual([])

    write('2026-10-19', '第二版')
    commit('text changed, date kept', '2026-10-20T09:00:00')
    expect(
      lib.verificationProblems(repo, ['docs/page.md'], '2026-10-21'),
    ).toEqual([expect.stringContaining('正文在 2026-10-20')])

    write('2026-10-20', '第二版')
    commit('checked again', '2026-10-20T10:00:00')
    expect(
      lib.verificationProblems(repo, ['docs/page.md'], '2026-10-21'),
    ).toEqual([])
  })

  it('ignores a reformatting commit', () => {
    write('2026-10-20', '| a | b |\n| - | - |\n| 1 | 2 |')
    commit('table', '2026-10-20T11:00:00')
    write('2026-10-20', '| a   | b   |\n| --- | --- |\n| 1   | 2   |')
    commit('style: prettier', '2026-10-21T08:00:00')
    expect(
      lib.verificationProblems(repo, ['docs/page.md'], '2026-10-21'),
    ).toEqual([])
  })

  it('fails an uncommitted change until the date is today', () => {
    write('2026-10-20', '| a | b |\n| - | - |\n| 1 | 3 |')
    expect(
      lib.verificationProblems(repo, ['docs/page.md'], '2026-10-21'),
    ).toEqual([expect.stringContaining('未提交的改动')])
    write('2026-10-21', '| a | b |\n| - | - |\n| 1 | 3 |')
    expect(
      lib.verificationProblems(repo, ['docs/page.md'], '2026-10-21'),
    ).toEqual([])
  })

  it('fails a date in the future and a commit that does not exist', () => {
    write('2026-10-30', '| a | b |\n| - | - |\n| 1 | 3 |')
    expect(
      lib.verificationProblems(repo, ['docs/page.md'], '2026-10-21'),
    ).toEqual([expect.stringContaining('晚于今天')])
    write(
      '2026-10-21（对照 `0123456789abcdef`）',
      '| a | b |\n| - | - |\n| 1 | 3 |',
    )
    expect(
      lib.verificationProblems(repo, ['docs/page.md'], '2026-10-21'),
    ).toEqual([expect.stringContaining('0123456789abcdef 不存在')])
  })
})

describe('the repository (tests 2, 3, 6, 7)', () => {
  it('checks only the newest version of the changelog', async () => {
    const lib = await load()
    expect(
      lib.currentChangelog(
        '# 更新日志\n\n## [0.2.0]\n\n新\n\n## [0.1.0]\n\n旧\n',
      ),
    ).toBe('# 更新日志\n\n## [0.2.0]\n\n新\n\n')
  })

  it('has no broken settings path, operation, private reference or stale 最后核验', async () => {
    const lib = await load()
    expect(lib.checkDocReferences(REPO)).toEqual({
      settings: [],
      operations: [],
      private: [],
      verified: [],
    })
  }, 60_000)
})
