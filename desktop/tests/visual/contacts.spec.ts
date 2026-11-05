import { expect, test } from './baseline'
import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadContactTemplates } from '../../../packages/core/src/contacts/templates'
import { installVisualCoreBridge } from './visualBridge'

// GRP-04: the contact editor (预览 B 第 1 步) — screenshots only, no
// baselines (the visual budget is kept for MOD-03): a contact from a
// template with a trial run, the avatar library, drafting from a
// description with its 「AI 起草」 marks, a builtin, and a narrow window.
// The contacts operations are answered here, over the shared bridge.
const screenshotDir = resolve(process.cwd(), 'screenshots', 'contacts')
const templates = loadContactTemplates(
  resolve(process.cwd(), '..', 'templates'),
).templates

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

type Theme = 'dark' | 'light'

async function install(page: Page) {
  await installVisualCoreBridge(page)
  await page.addInitScript(
    ({ templates: shipped }) => {
      const PRESETS: Record<string, string[]> = {
        read_only: ['glob', 'grep', 'read', 'skill', 'todo_write'],
        research: [
          'glob',
          'grep',
          'read',
          'skill',
          'todo_write',
          'web_fetch',
          'web_search',
        ],
        writer: [
          'edit',
          'glob',
          'grep',
          'read',
          'skill',
          'todo_write',
          'web_fetch',
          'web_search',
          'write',
        ],
        engineer: [
          'bash',
          'edit',
          'glob',
          'grep',
          'job_kill',
          'job_list',
          'job_output',
          'read',
          'skill',
          'todo_write',
          'web_fetch',
          'web_search',
          'write',
        ],
        custom: [],
      }
      type Row = Record<string, unknown>
      const base = (overrides: Row): Row => ({
        kind: 'local',
        intro: '',
        domains: ['engineering'],
        role: {
          mission: '',
          deliverable: '',
          playbook: '',
          boundaries: '',
          knowledge: [],
        },
        capabilities: {
          model: 'inherit',
          tools: { preset: 'read_only' },
          permission: 'read_only',
        },
        groupHabit: { speak: 'relevant', length: 'brief' },
        memory: { enabled: true },
        version: 1,
        builtin: false,
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
      })
      const contacts = [
        base({
          id: 'ct-emperor',
          name: 'Emperor',
          avatar: { kind: 'mascot', pose: 'crown-head' },
          intro: '你的主智能体：统筹、拆解任务，在群里主持讨论',
          builtin: true,
          role: {
            mission: '你是 Emperor……',
            deliverable: '',
            playbook: '',
            boundaries: '',
            knowledge: [],
          },
          capabilities: {
            model: 'inherit',
            tools: { preset: 'engineer' },
            permission: 'inherit',
          },
        }),
        base({
          id: 'ct-claude-code',
          kind: 'external',
          backend: 'claude-code',
          name: 'Claude Code',
          avatar: { kind: 'logo', backend: 'claude-code' },
          builtin: true,
        }),
        base({
          id: 'ct-codex',
          kind: 'external',
          backend: 'codex',
          name: 'Codex',
          avatar: { kind: 'logo', backend: 'codex' },
          builtin: true,
        }),
        base({
          id: 'ct-reviewer00001',
          name: '审稿人',
          avatar: { kind: 'library', id: 'AV-01-2' },
          intro: '代码与方案评审',
          role: {
            mission: '审查改动。',
            deliverable: '问题清单。',
            playbook: '1. 读改动\n2. 列问题',
            boundaries: '不改代码。',
            knowledge: [],
          },
          templateId: 'code-reviewer',
        }),
        base({
          id: 'ct-researcher001',
          name: '研究员',
          avatar: { kind: 'library', id: 'AV-04-1' },
          intro: '资料调研与核实',
          domains: ['content'],
        }),
      ]
      const used = () =>
        contacts.flatMap((contact) => {
          const avatar = contact.avatar as { kind: string; id?: string }
          return avatar.kind === 'library' && avatar.id ? [avatar.id] : []
        })
      const THEME_SHEETS: Record<string, string[]> = {
        engineering: ['AV-01', 'AV-02'],
        design: ['AV-03'],
        content: ['AV-04'],
        product: ['AV-05'],
      }
      let shuffle = 0
      function recommend(input: { templateId?: string; exclude?: string[] }) {
        const template = shipped.find((item) => item.id === input.templateId)
        const sheets = template
          ? (THEME_SHEETS[template.avatarTheme] ?? ['AV-13'])
          : ['AV-13', 'AV-10', 'AV-12']
        const pool = sheets.flatMap((sheet) =>
          Array.from({ length: 9 }, (_, i) => `${sheet}-${i + 1}`),
        )
        const skip = new Set([...used(), ...(input.exclude ?? [])])
        const free = pool.filter((id) => !skip.has(id))
        const id = (free.length ? free : pool)[
          (shuffle++ * 5 + 3) % (free.length || pool.length)
        ]!
        return { id, theme: template?.avatarTheme ?? 'people' }
      }
      function compile(draft: Record<string, any>) {
        const role = draft.role ?? {}
        const name = draft.name || '新联系人'
        const parts = [
          `# 身份\n\n你是「${name}」，Emperor 团队里的一位联系人。${draft.intro ? `\n${draft.intro}` : ''}`,
          role.mission || role.deliverable
            ? `# 职责与交付\n\n${[role.mission, role.deliverable].filter(Boolean).join('\n\n')}`
            : '',
          role.playbook ? `# 工作方法\n\n${role.playbook}` : '',
          role.boundaries ? `# 边界\n\n${role.boundaries}` : '',
          (role.knowledge ?? []).length
            ? `# 参考资料\n\n以下是只读参考资料，回答时注明出处。`
            : '',
        ].filter(Boolean)
        return parts.join('\n\n')
      }
      const bridge = (
        window as unknown as {
          emperor: {
            invokeCore: (op: string, ...args: unknown[]) => Promise<unknown>
          }
        }
      ).emperor
      const original = bridge.invokeCore
      bridge.invokeCore = async (op: string, ...args: unknown[]) => {
        const input = (args[0] ?? {}) as Record<string, any>
        switch (op) {
          case 'contacts.list':
            return { contacts, readOnly: null }
          case 'contacts.templates':
            return shipped
          case 'contacts.get':
            return contacts.find((contact) => contact.id === input.id)
          case 'contacts.recommendAvatar':
            return recommend(input)
          case 'contacts.preview': {
            const draft = input.draft ?? {}
            if (draft.id === 'ct-emperor') {
              const prompt = '你是 Emperor Agent，用户的主智能体……'
              return {
                prompt,
                chars: prompt.length,
                tools: null,
                presets: PRESETS,
              }
            }
            const prompt = compile(draft)
            const tools = draft.capabilities?.tools ?? { preset: 'read_only' }
            const names = new Set(
              tools.preset === 'custom' ? [] : PRESETS[tools.preset],
            )
            for (const name of tools.allow ?? []) names.add(name)
            for (const name of tools.deny ?? []) names.delete(name)
            return {
              prompt,
              chars: Array.from(prompt).length,
              tools: [...names].sort(),
              presets: PRESETS,
            }
          }
          case 'contacts.trial':
            await new Promise((resolve) => setTimeout(resolve, 300))
            return {
              trialId: input.trialId,
              status: 'completed',
              text: '1. 高 · git-runner.ts:212 分支名直接拼进参数 → 以 - 开头时被当成选项。修法：在分支名前加 --。置信度 高。\n2. 未发现：密钥、日志泄露（查过 4 个文件）。',
              costUsd: 0.0123,
              usage: { inputTokens: 18_420, outputTokens: 1_260 },
              durationMs: 41_000,
              at: Date.now(),
            }
          case 'contacts.stopTrial':
            return { stopped: true }
          case 'contacts.draftFromBrief':
            if (!input.answers)
              return {
                kind: 'questions',
                questions: [
                  '主要审什么语言、什么类型的项目？',
                  '发现问题时要不要顺手给出修改？',
                  '有没有必须遵守的规范或文档？',
                ],
                costUsd: 0.0008,
              }
            return {
              kind: 'draft',
              draft: {
                name: 'TS 安全审稿',
                intro: '审 TypeScript 改动里的安全问题，只读不改',
                domains: ['engineering', 'security'],
                role: {
                  mission:
                    '审查 TypeScript 改动中的安全问题：注入、越权、敏感信息泄露、不安全的依赖。',
                  deliverable:
                    '按严重程度排序的问题清单，每条写「位置 · 问题 · 利用条件 · 修法 · 置信度」；没有问题时写「未发现」并列出查过的范围。',
                  playbook:
                    '1. 弄清改动的意图和信任边界。\n2. 沿数据流追：输入 → 校验 → 使用点。\n3. 查密钥与凭据。\n4. 看新加或升级的依赖。\n\n检查清单：\n- 每个发现都能复现\n- 复现不了的标「待确认」',
                  boundaries:
                    '不改代码，不跑会联网或改数据的命令；发现高危问题立即单独报告。',
                  trialTask: '审查 git-runner.ts 里新加的 diff 调用',
                },
                tools: 'read_only',
                permission: 'read_only',
                speak: 'relevant',
              },
              sections: [
                'identity',
                'mission',
                'playbook',
                'boundaries',
                'capabilities',
                'groupHabit',
              ],
              costUsd: 0.0031,
            }
          case 'contacts.create':
            return { ...base({ id: 'ct-new000000001' }), ...input }
          case 'contacts.update':
            return {
              ...contacts.find((contact) => contact.id === input.id),
              ...input.patch,
            }
          default:
            return original(op, ...args)
        }
      }
    },
    { templates },
  )
}

async function open(page: Page, path: string, theme: Theme, width = 1280) {
  await page.setViewportSize({ width, height: 860 })
  await page.goto(`${path}?visualTheme=${theme}`)
  await expect(page.locator('[data-contact-editor]')).toBeVisible()
}

async function shot(page: Page, name: string, fullPage = false) {
  await page.mouse.move(5, 850)
  await page.waitForTimeout(450)
  await page.screenshot({
    path: resolve(screenshotDir, `${name}.png`),
    animations: 'disabled',
    fullPage,
  })
}

for (const theme of ['dark', 'light'] as const) {
  test(`a contact from a template, tried once (${theme})`, async ({ page }) => {
    await install(page)
    await open(page, '/contacts/advanced/new', theme)
    await expect(page.getByTestId('sidebar-brand')).toHaveText('Emperor Group')
    await page.locator('[data-template="security-auditor"] button').click()
    await expect(page.locator('[data-field="name"] input')).toHaveValue(
      '安全审计',
    )
    await page.getByRole('button', { name: '运行' }).click()
    await expect(page.locator('[data-trial-status="completed"]')).toBeVisible()
    await expect(page.locator('[data-compiled-prompt]')).toContainText(
      '你是「安全审计」',
    )
    await expect(page.locator('[data-completeness]')).toContainText('5 / 5')
    await shot(page, `editor-template-${theme}`)
    // The whole form, for review.
    await page
      .locator('.main')
      .evaluate((element) => element.scrollTo(0, 99999))
    await shot(page, `editor-template-bottom-${theme}`)
  })

  test(`the avatar library (${theme})`, async ({ page }) => {
    await install(page)
    await open(page, '/contacts/advanced/new', theme)
    await page.locator('[data-template="security-auditor"] button').click()
    await page.getByRole('button', { name: '从头像库选…' }).click()
    const picker = page.locator('[data-avatar-library]')
    await expect(picker.locator('[data-avatar-cell]')).toHaveCount(135)
    await expect(picker.locator('[data-avatar-cell="AV-01-2"]')).toContainText(
      '在用',
    )
    await shot(page, `avatar-library-${theme}`)
    await picker.getByRole('searchbox', { name: '搜索头像' }).fill('猫')
    await shot(page, `avatar-library-search-${theme}`)
  })

  test(`drafting from a description (${theme})`, async ({ page }) => {
    await install(page)
    await open(page, '/contacts/advanced/new', theme)
    await page.locator('[data-method="brief"]').click()
    await page
      .locator('[data-brief] textarea')
      .fill('帮我审 TypeScript 改动里的安全问题，只读不改，发现高危马上说')
    await page.getByRole('button', { name: '起草', exact: true }).click()
    await expect(page.locator('[data-brief-question]')).toHaveCount(3)
    await page
      .locator('[data-brief-question] input')
      .first()
      .fill('TypeScript 的桌面应用')
    await shot(page, `brief-questions-${theme}`)
    await page.getByRole('button', { name: '交给 Emperor 起草' }).click()
    await expect(page.locator('[data-field="name"] input')).toHaveValue(
      'TS 安全审稿',
    )
    await expect(page.locator('[data-ai-drafted]')).toHaveCount(6)
    await shot(page, `brief-drafted-${theme}`)
  })

  test(`a builtin contact (${theme})`, async ({ page }) => {
    await install(page)
    await open(page, '/contacts/ct-emperor/advanced', theme)
    await expect(page.locator('[data-contact-editor]')).toContainText(
      '内置联系人只能改头像和简介',
    )
    await shot(page, `builtin-${theme}`)
  })
}

test('a narrow window puts the checks under the form', async ({ page }) => {
  await install(page)
  await open(page, '/contacts/advanced/new', 'dark', 900)
  await page.locator('[data-template="writer"] button').click()
  await shot(page, 'editor-narrow-dark')
})
