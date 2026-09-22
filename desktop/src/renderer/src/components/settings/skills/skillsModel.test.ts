import { describe, expect, it } from 'vitest'
import type { InvalidSkillInfo, SkillInfo } from '../../../types'
import {
  basenameOf,
  canCopySkillToUser,
  canDeleteSkill,
  canSaveSkill,
  detectFrontmatterName,
  filterInvalidSkills,
  filterSkills,
  invalidSkillDeleteTarget,
  invalidSkillFolder,
  isSkillReadOnly,
  skillCountText,
  skillFacts,
  skillFolder,
  skillImportErrorSummary,
  skillImportToast,
  skillProject,
  skillScopeOptions,
  skillSessionId,
  skillSource,
  skillSourceCounts,
  skillUrlError,
  skillValidationBadge,
  summarizeSkillImport,
  uniqueMessages,
  withFrontmatterName,
} from './skillsModel'

function skill(
  name: string,
  source: SkillInfo['source'],
  extra: Partial<SkillInfo> = {},
): SkillInfo {
  return {
    name,
    description: `${name} description`,
    path: `skills/${name}/SKILL.md`,
    source,
    readOnly: source === 'builtin' || source === 'plugin',
    ...extra,
  }
}

function invalid(
  name: string,
  source: InvalidSkillInfo['source'],
  path = `/home/me/.emperor/skills/${name}`,
): InvalidSkillInfo {
  return {
    name,
    source,
    path,
    reason: 'missing description',
    errors: ['description is required'],
    warnings: [],
  }
}

const catalog = [
  skill('skill-creator', 'builtin', { tags: 'meta authoring' }),
  skill('release-notes', 'project'),
  skill('writer', 'user', { description: 'Long form drafting' }),
  skill('docx', 'plugin'),
  skill('audit', 'user'),
  skill('legacy', 'verified_plugin'),
]

describe('skill sources and read-only rules', () => {
  it('normalizes sources (verified_plugin → plugin, unknown → user)', () => {
    expect(skillSource({ source: 'verified_plugin' })).toBe('plugin')
    expect(skillSource({ source: 'project' })).toBe('project')
    expect(skillSource({ source: undefined })).toBe('user')
  })

  it('builtin and plugin Skills are read-only; copy is offered only there', () => {
    const builtin = skill('a', 'builtin')
    const plugin = skill('b', 'plugin')
    const personal = skill('c', 'user')
    const project = skill('d', 'project')
    for (const item of [builtin, plugin]) {
      expect(isSkillReadOnly(item)).toBe(true)
      expect(canSaveSkill(item)).toBe(false)
      expect(canDeleteSkill(item)).toBe(false)
      expect(canCopySkillToUser(item)).toBe(true)
    }
    for (const item of [personal, project]) {
      expect(isSkillReadOnly(item)).toBe(false)
      expect(canSaveSkill(item)).toBe(true)
      expect(canDeleteSkill(item)).toBe(true)
      expect(canCopySkillToUser(item)).toBe(false)
    }
  })

  it('falls back to the source when Core omits readOnly', () => {
    expect(isSkillReadOnly({ source: 'builtin' })).toBe(true)
    expect(isSkillReadOnly({ source: 'verified_plugin' })).toBe(true)
    expect(isSkillReadOnly({ source: 'user' })).toBe(false)
    expect(isSkillReadOnly({ source: 'builtin', readOnly: false })).toBe(false)
  })
})

describe('list filtering and grouping', () => {
  it('orders by source (个人, 项目, 插件, 内置) then name', () => {
    expect(filterSkills(catalog).map((item) => item.name)).toEqual([
      'audit',
      'writer',
      'release-notes',
      'docx',
      'legacy',
      'skill-creator',
    ])
  })

  it('filters by source', () => {
    expect(
      filterSkills(catalog, { source: 'plugin' }).map((item) => item.name),
    ).toEqual(['docx', 'legacy'])
    expect(
      filterSkills(catalog, { source: 'project' }).map((item) => item.name),
    ).toEqual(['release-notes'])
  })

  it('searches name, description, tags and path; every term must match', () => {
    expect(
      filterSkills(catalog, { query: 'LONG form' }).map((item) => item.name),
    ).toEqual(['writer'])
    expect(
      filterSkills(catalog, { query: 'authoring' }).map((item) => item.name),
    ).toEqual(['skill-creator'])
    expect(filterSkills(catalog, { query: 'writer zzz' })).toEqual([])
    expect(
      filterSkills(catalog, { query: 'skills/docx' }).map((item) => item.name),
    ).toEqual(['docx'])
  })

  it('combines source and query', () => {
    expect(
      filterSkills(catalog, { query: 'description', source: 'user' }).map(
        (item) => item.name,
      ),
    ).toEqual(['audit'])
  })

  it('counts Skills per source and formats the search count', () => {
    expect(skillSourceCounts(catalog)).toEqual({
      all: 6,
      user: 2,
      project: 1,
      plugin: 2,
      builtin: 1,
    })
    expect(skillCountText(6, 6)).toBe('6 个')
    expect(skillCountText(2, 6)).toBe('2 / 6')
    expect(skillCountText(0, 0)).toBe('')
  })

  it('filters invalid Skills with the same source filter and search', () => {
    const items = [
      invalid('broken', 'user'),
      invalid('odd', 'project', '/repo/.emperor/skills/odd.md'),
      invalid('vendor', 'plugin'),
    ]
    expect(
      filterInvalidSkills(items, { source: 'project' }).map((i) => i.name),
    ).toEqual(['odd'])
    expect(
      filterInvalidSkills(items, { query: 'vendor' }).map((i) => i.name),
    ).toEqual(['vendor'])
    expect(filterInvalidSkills(items).map((i) => i.name)).toEqual([
      'broken',
      'odd',
      'vendor',
    ])
  })
})

describe('invalid Skill actions', () => {
  it('deletes personal / project invalid Skills by folder name and scope', () => {
    expect(
      invalidSkillDeleteTarget(
        invalid('Broken Name', 'user', '/home/me/.emperor/skills/broken_dir/'),
      ),
    ).toEqual({ name: 'broken_dir', scope: 'user' })
    expect(
      invalidSkillDeleteTarget(
        invalid('odd', 'project', 'C:\\repo\\.emperor\\skills\\odd.md'),
      ),
    ).toEqual({ name: 'odd.md', scope: 'project' })
  })

  it('never deletes builtin or plugin invalid Skills', () => {
    expect(invalidSkillDeleteTarget(invalid('x', 'builtin'))).toBeNull()
    expect(invalidSkillDeleteTarget(invalid('x', 'plugin'))).toBeNull()
  })

  it('reveals the folder of a single-file Skill', () => {
    expect(invalidSkillFolder(invalid('a', 'user', '/s/a'))).toBe('/s/a')
    expect(invalidSkillFolder(invalid('b', 'user', '/s/b.md'))).toBe('/s')
    expect(basenameOf('/a/b/')).toBe('b')
    expect(
      skillFolder({ path: 'x', skillFile: '/s/flat.md', root: undefined }),
    ).toBe('/s')
    expect(skillFolder({ path: 'x', root: '/s/folder' })).toBe('/s/folder')
  })
})

describe('detail facts', () => {
  it('lists source, file, tags and requirements', () => {
    const facts = skillFacts(
      skill('skill-creator', 'builtin', {
        skillFile: '/app/skills/skill-creator/SKILL.md',
        tags: 'meta, authoring',
        always: true,
        requirements: { bins: ['git'], runtimes: ['python'], env: ['TOKEN'] },
      }),
    )
    expect(Object.fromEntries(facts.map((f) => [f.key, f.value]))).toEqual({
      source: '内置',
      file: '/app/skills/skill-creator/SKILL.md',
      tags: 'meta、authoring',
      requirements: '命令 git · 运行时 python · 环境变量 TOKEN',
      always: '始终注入上下文',
    })
  })
})

describe('sessions and scopes', () => {
  it('drops empty and draft session ids', () => {
    expect(skillSessionId('build-ui')).toBe('build-ui')
    expect(skillSessionId('')).toBeNull()
    expect(skillSessionId(null)).toBeNull()
    expect(skillSessionId('draft:abc')).toBeNull()
  })

  it('offers the project scope only for a persisted Build session', () => {
    expect(
      skillProject({
        mode: 'build',
        project_path: '/work/app',
        project_name: 'App',
      }),
    ).toEqual({ name: 'App', path: '/work/app' })
    expect(
      skillProject({ mode: 'build', project_path: '/work/app', draft: true }),
    ).toBeNull()
    expect(skillProject({ mode: 'chat', project_path: '/work/app' })).toBeNull()
    expect(skillProject({ mode: 'build', project_path: '' })).toBeNull()
    expect(skillScopeOptions(null).map((o) => o.value)).toEqual(['user'])
    expect(
      skillScopeOptions({ name: 'App', path: '/work/app' }).map((o) => o.label),
    ).toEqual(['个人', '当前项目 · App'])
  })
})

describe('frontmatter name detection', () => {
  it('reads the top-level name', () => {
    expect(
      detectFrontmatterName('---\nname: my-skill\ndescription: x\n---\n# T\n'),
    ).toBe('my-skill')
  })

  it('handles quotes, comments, CRLF and a BOM', () => {
    expect(detectFrontmatterName('---\nname: "quoted.skill"\n---\n')).toBe(
      'quoted.skill',
    )
    expect(detectFrontmatterName("---\nname: 'single'\n---\n")).toBe('single')
    expect(detectFrontmatterName('---\nname: plain # note\n---\n')).toBe(
      'plain',
    )
    expect(
      detectFrontmatterName('\uFEFF---\r\nname: crlf_skill\r\n---\r\n'),
    ).toBe('crlf_skill')
  })

  it('takes the last duplicate key, ignores nested keys and the body', () => {
    expect(
      detectFrontmatterName(
        '---\nname: first\nmetadata:\n  name: nested\nname: second\n---\nname: body\n',
      ),
    ).toBe('second')
  })

  it('returns null without frontmatter, name or closing fence', () => {
    expect(detectFrontmatterName('# Just markdown\nname: x')).toBeNull()
    expect(detectFrontmatterName('---\ndescription: x\n---\n')).toBeNull()
    expect(detectFrontmatterName('---\nname: open\n')).toBeNull()
    expect(detectFrontmatterName('---\nname:\n---\n')).toBeNull()
  })

  it('rewrites or inserts the frontmatter name for a renamed paste', () => {
    expect(
      withFrontmatterName('---\nname: old\ndescription: x\n---\nbody', 'new'),
    ).toBe('---\nname: new\ndescription: x\n---\nbody')
    expect(withFrontmatterName('---\ndescription: x\n---\n', 'added')).toBe(
      '---\nname: added\ndescription: x\n---\n',
    )
    expect(withFrontmatterName('no frontmatter', 'x')).toBe('no frontmatter')
    expect(withFrontmatterName('---\nname: a\n---\n', '  ')).toBe(
      '---\nname: a\n---\n',
    )
  })
})

describe('import result mapping', () => {
  it('summarizes a clean single import', () => {
    const summary = summarizeSkillImport({
      imported: [
        {
          name: 'writer',
          scope: 'user',
          path: '/home/me/.emperor/skills/writer',
          warnings: [],
          replaced: false,
        },
      ],
      errors: [],
    })
    expect(summary.tone).toBe('ok')
    expect(summary.headline).toBe('已导入 Skill「writer」')
    expect(summary.imported[0]?.scopeLabel).toBe('个人')
    expect(summary.conflicts).toEqual([])
    expect(skillImportToast(summary)).toBe('已导入 Skill「writer」')
  })

  it('flags warnings, failures and same-name conflicts', () => {
    const summary = summarizeSkillImport({
      imported: [
        {
          name: 'a',
          scope: 'project',
          path: '/repo/.emperor/skills/a',
          warnings: ['Skipped .venv'],
          replaced: true,
        },
      ],
      errors: [
        {
          code: 'skill_exists',
          name: 'b',
          path: 'skills/b',
          reason:
            'A Skill named "b" already exists; choose overwrite to replace it',
        },
        {
          code: 'skill_invalid',
          name: null,
          path: 'skills/c',
          reason: 'SKILL.md has no description',
        },
        {
          code: 'skill_duplicate',
          name: 'd',
          path: 'skills/d-copy',
          reason: 'Another Skill in this import is also named "d"',
        },
      ],
    })
    expect(summary.tone).toBe('warn')
    expect(summary.headline).toBe('已导入 Skill「a」，3 个失败')
    expect(summary.imported[0]).toMatchObject({
      scopeLabel: '项目',
      replaced: true,
      warnings: ['Skipped .venv'],
    })
    expect(summary.failures.map((f) => f.conflict)).toEqual([
      true,
      false,
      false,
    ])
    expect(summary.conflicts).toEqual(['b'])
    expect(skillImportToast(summary)).toBe(
      '已导入 Skill「a」，3 个失败（覆盖 1 个）',
    )
  })

  it('headlines an import that only hit conflicts', () => {
    const summary = summarizeSkillImport({
      imported: [],
      errors: [
        {
          code: 'skill_exists',
          name: 'x',
          path: '.',
          reason: 'A Skill named "x" already exists; choose overwrite',
        },
      ],
    })
    expect(summary.tone).toBe('error')
    expect(summary.headline).toBe('已存在同名 Skill：x')
    expect(summary.conflicts).toEqual(['x'])
    expect(summarizeSkillImport({ imported: [], errors: [] }).headline).toBe(
      '没有导入任何 Skill',
    )
  })

  it('maps a thrown skill_exists error to an overwritable conflict', () => {
    const summary = skillImportErrorSummary(
      { code: 'skill_exists', action: 'overwrite', message: 'exists' },
      'writer',
    )
    expect(summary.conflicts).toEqual(['writer'])
    expect(summary.failures[0]?.conflict).toBe(true)
    const failed = skillImportErrorSummary({
      code: 'skill_import_failed',
      action: null,
      message: 'No SKILL.md was found in the imported source',
    })
    expect(failed.conflicts).toEqual([])
    expect(failed.headline).toBe('导入失败')
  })

  it('detects conflicts by failure code, not by reason text', () => {
    const summary = summarizeSkillImport({
      imported: [],
      errors: [
        {
          code: 'skill_duplicate',
          name: 'y',
          path: 'skills/y',
          reason: 'A Skill named "y" already exists; choose overwrite',
        },
      ],
    })
    expect(summary.failures[0]?.conflict).toBe(false)
    expect(summary.conflicts).toEqual([])
    expect(summary.headline).toBe('导入失败（1 个）')
    const thrown = skillImportErrorSummary(
      {
        code: 'skill_invalid',
        action: null,
        message: 'A Skill named "z" already exists',
      },
      'z',
    )
    expect(thrown.conflicts).toEqual([])
    expect(thrown.headline).toBe('导入失败')
  })
})

describe('URL field', () => {
  it('accepts https links only', () => {
    expect(skillUrlError('')).toBe('')
    expect(skillUrlError('https://github.com/o/r/tree/main/skills/x')).toBe('')
    expect(skillUrlError('http://example.com/a.zip')).toBe('只支持 https 链接')
    expect(skillUrlError('github.com/o/r')).toMatch(/完整的链接/)
  })
})

describe('validation badge', () => {
  it('maps pending, failure, errors, warnings and ok', () => {
    expect(skillValidationBadge({ pending: true, result: null })?.label).toBe(
      '校验中…',
    )
    expect(
      skillValidationBadge({ pending: false, failure: 'x', result: null }),
    ).toEqual({ tone: 'error', label: '无法校验' })
    expect(skillValidationBadge({ pending: false, result: null })).toBeNull()
    expect(
      skillValidationBadge({
        pending: false,
        result: { valid: false, errors: ['a', 'b'], warnings: [] },
      }),
    ).toEqual({ tone: 'error', label: '2 个错误' })
    expect(
      skillValidationBadge({
        pending: false,
        result: { valid: true, errors: [], warnings: ['w'] },
      }),
    ).toEqual({ tone: 'warn', label: '1 条提示' })
    expect(
      skillValidationBadge({
        pending: false,
        result: { valid: true, errors: [], warnings: [] },
      }),
    ).toEqual({ tone: 'ok', label: '校验通过' })
    expect(uniqueMessages(['a', ' b '], ['b', '', 'c'])).toEqual([
      'a',
      'b',
      'c',
    ])
  })
})
