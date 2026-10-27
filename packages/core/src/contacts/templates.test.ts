// GRP-02 card test 10: the 18 role templates (D15) parse, carry every
// frontmatter field and all five sections; a broken template fails here,
// at build time, never in front of the user.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CONTACT_TEMPLATE_IDS,
  loadContactTemplates,
  parseContactTemplate,
} from './templates'
import {
  AVATAR_SHEET_THEMES,
  CONTACT_LIMITS,
  DOMAINS,
  LIBRARY_AVATAR_ID,
} from './types'

const TEMPLATES_DIR = join(__dirname, '..', '..', '..', '..', 'templates')
const CONTACTS_DIR = join(TEMPLATES_DIR, 'contacts')

const NAMES: Record<string, string> = {
  architect: '架构师',
  'code-reviewer': '代码审稿人',
  'test-engineer': '测试工程师',
  'security-auditor': '安全审计',
  'frontend-engineer': '前端工程师',
  'release-engineer': '运维与发布',
  'asset-designer': '素材设计师',
  'ui-reviewer': '界面设计评审',
  researcher: '研究员',
  writer: '写作者',
  editor: '编辑',
  translator: '译者',
  copywriter: '市场文案',
  'product-manager': '产品经理',
  'user-researcher': '用户研究员',
  'data-analyst': '数据分析师',
  'red-team': '反方（红队）',
  moderator: '主持人',
}

/** BRD-07: each template's default avatar. */
const AVATARS: Record<string, string> = {
  architect: 'AV-01-1',
  'code-reviewer': 'AV-01-2',
  'test-engineer': 'AV-01-3',
  'security-auditor': 'AV-01-4',
  'frontend-engineer': 'AV-01-5',
  'release-engineer': 'AV-01-7',
  'asset-designer': 'AV-03-1',
  'ui-reviewer': 'AV-03-2',
  researcher: 'AV-04-1',
  writer: 'AV-04-2',
  editor: 'AV-04-3',
  translator: 'AV-04-4',
  copywriter: 'AV-04-5',
  'product-manager': 'AV-05-1',
  'user-researcher': 'AV-05-2',
  'data-analyst': 'AV-05-3',
  'red-team': 'AV-05-4',
  moderator: 'AV-05-5',
}

/** Templates describe a job, never a model product. */
const MODEL_NAMES =
  /claude|anthropic|openai|gpt|chatgpt|gemini|codex|deepseek|qwen|通义|llama|mistral|opus|sonnet|haiku|kimi|glm|豆包|文心/i

const VALID = `---
name: 测试岗
intro: 一句话简介
domains: [engineering]
tools: read_only
permission: read_only
speak: relevant
modelHint: reasoning
avatarTheme: engineering
avatar: AV-01-1
---

## 职责

负责一件事。

## 交付

交出一份清单。

## 工作方法

1. 第一步
2. 第二步
3. 第三步
4. 第四步

## 边界

不做别的事。

## 样例任务

做一次。
`

describe('the role templates (card test 10)', () => {
  it('ships exactly the 18 templates of D15, in picker order', () => {
    const files = readdirSync(CONTACTS_DIR)
      .filter((file) => !file.startsWith('.'))
      .sort()
    expect(files).toEqual(
      [...CONTACT_TEMPLATE_IDS].map((id) => `${id}.md`).sort(),
    )
    const { templates, errors } = loadContactTemplates(TEMPLATES_DIR)
    expect(errors).toEqual([])
    expect(templates.map((template) => template.id)).toEqual([
      ...CONTACT_TEMPLATE_IDS,
    ])
    expect(Object.fromEntries(templates.map((t) => [t.id, t.name]))).toEqual(
      NAMES,
    )
  })

  it('gives every template its fields, five sections and a real method', () => {
    const { templates } = loadContactTemplates(TEMPLATES_DIR)
    for (const template of templates) {
      const where = template.id
      expect(template.intro.length, where).toBeGreaterThan(0)
      expect(Array.from(template.intro).length, where).toBeLessThanOrEqual(
        CONTACT_LIMITS.intro,
      )
      expect(template.intro, where).not.toMatch(/\n/)
      expect(template.domains.length, where).toBeGreaterThan(0)
      expect(template.domains.length, where).toBeLessThanOrEqual(3)
      for (const domain of template.domains)
        expect(DOMAINS, where).toContain(domain)
      expect(template.avatar, where).toBe(AVATARS[template.id])
      expect(template.avatar, where).toMatch(LIBRARY_AVATAR_ID)
      expect(AVATAR_SHEET_THEMES[template.avatar.slice(0, 5)], where).toBe(
        template.avatarTheme,
      )

      const { role } = template
      for (const [field, limit] of [
        ['mission', CONTACT_LIMITS.mission],
        ['deliverable', CONTACT_LIMITS.deliverable],
        ['playbook', CONTACT_LIMITS.playbook],
        ['boundaries', CONTACT_LIMITS.boundaries],
        ['trialTask', CONTACT_LIMITS.trialTask],
      ] as const) {
        const text = role[field] ?? ''
        expect(text.trim().length, `${where} ${field}`).toBeGreaterThan(20)
        expect(text.length, `${where} ${field}`).toBeLessThanOrEqual(limit)
      }
      const steps = role.playbook.match(/^\d+\. /gm) ?? []
      expect(steps.length, `${where} playbook steps`).toBeGreaterThanOrEqual(4)
      expect(role.knowledge, where).toEqual([])

      const source = readFileSync(join(CONTACTS_DIR, `${where}.md`), 'utf8')
      expect(source, `${where} names a model`).not.toMatch(MODEL_NAMES)
      // The tool preset and the permission agree (GRP-04 completeness rule).
      if (template.tools === 'writer' || template.tools === 'engineer')
        expect(template.permission, where).toBe('workspace_write')
      else expect(template.permission, where).toBe('read_only')
    }
  })

  it('makes the asset designer write prompt packs and hand generation on', () => {
    const { templates } = loadContactTemplates(TEMPLATES_DIR)
    const designer = templates.find((t) => t.id === 'asset-designer')!
    expect(designer.role.deliverable).toMatch(/提示词包/)
    expect(designer.role.deliverable).toMatch(/验收清单/)
    for (const word of ['色板', '尺寸', '背景', '参考图', '候选'])
      expect(designer.role.deliverable + designer.role.playbook).toContain(word)
    expect(designer.role.boundaries).toMatch(/不(自己)?出图/)
    expect(designer.modelHint).toBe('vision')
  })

  it('fails on a missing field, a missing section or a thin method', () => {
    expect(parseContactTemplate('ok', VALID).name).toBe('测试岗')
    expect(() =>
      parseContactTemplate('x', VALID.replace('name: 测试岗\n', '')),
    ).toThrow(/name/)
    expect(() =>
      parseContactTemplate(
        'x',
        VALID.replace('avatarTheme: engineering\n', ''),
      ),
    ).toThrow(/avatarTheme/)
    expect(() =>
      parseContactTemplate(
        'x',
        VALID.replace('tools: read_only', 'tools: root'),
      ),
    ).toThrow(/tools/)
    expect(() =>
      parseContactTemplate('x', VALID.replace('## 边界\n\n不做别的事。\n', '')),
    ).toThrow(/边界/)
    expect(() =>
      parseContactTemplate('x', VALID.replace('4. 第四步\n', '')),
    ).toThrow(/工作方法/)
    expect(() =>
      parseContactTemplate('x', VALID.replace('---\nname', 'name')),
    ).toThrow(/frontmatter/)
    expect(() =>
      parseContactTemplate('x', `${VALID}\n## 附录\n\n多出来的一节。\n`),
    ).toThrow(/附录/)
  })
})
