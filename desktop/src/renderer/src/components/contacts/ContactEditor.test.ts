// @vitest-environment jsdom
/**
 * GRP-04: the contact editor (预览 B 第 1 步) — the four ways to start, the
 * seven sections with their character hints, the 「AI 起草」 marks, the
 * completeness check, the compiled prompt, saving a new contact and editing
 * a saved one (builtins: avatar and intro only).
 */
import { createApp, h, nextTick, type App } from 'vue'
import {
  createMemoryHistory,
  createRouter,
  RouterView,
  type Router,
} from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Contact,
  ContactTemplate,
  ContactsListing,
} from '@emperor/core/api'
import { APP_CONTEXT_KEY } from '../../composables/useAppContext'
import { answerConfirmsForTest } from '../ui/confirm'

const { core } = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../../api/http', () => ({ core }))
const { selectFile } = vi.hoisted(() => ({ selectFile: vi.fn() }))
vi.mock('../../api/backend', async (original) => ({
  ...(await original<typeof import('../../api/backend')>()),
  selectFile,
}))

const { default: ContactEditor } = await import('./ContactEditor.vue')

const PRESETS = {
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

function template(
  id: string,
  name: string,
  theme: ContactTemplate['avatarTheme'],
  extra: Partial<ContactTemplate> = {},
): ContactTemplate {
  return {
    id,
    name,
    intro: `${name}的简介`,
    domains: ['engineering'],
    tools: 'read_only',
    permission: 'read_only',
    speak: 'relevant',
    modelHint: 'reasoning',
    avatarTheme: theme,
    avatar: 'AV-01-4',
    role: {
      mission: `${name}的职责。`,
      deliverable: '问题清单。',
      playbook: '1. 第一步\n2. 第二步\n3. 第三步\n4. 第四步',
      boundaries: '不改代码。',
      knowledge: [],
      trialTask: `${name}的样例任务`,
    },
    ...extra,
  }
}

const TEMPLATES = [
  template('security-auditor', '安全审计', 'engineering'),
  template('asset-designer', '素材设计师', 'design', { avatar: 'AV-03-1' }),
  template('writer', '写作者', 'content', {
    avatar: 'AV-04-2',
    tools: 'writer',
    permission: 'workspace_write',
  }),
  template('moderator', '主持人', 'product', { avatar: 'AV-05-5' }),
]

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'ct-reviewer00001',
    kind: 'local',
    name: '审稿人',
    avatar: { kind: 'library', id: 'AV-01-2' },
    intro: '代码与方案评审',
    domains: ['engineering'],
    role: {
      mission: '审查改动。',
      deliverable: '问题清单。',
      playbook: '1. 读改动\n2. 列问题',
      boundaries: '不改代码。',
      knowledge: [],
    },
    capabilities: {
      model: 'inherit',
      tools: { preset: 'read_only' },
      permission: 'read_only',
    },
    groupHabit: { speak: 'relevant', length: 'brief' },
    memory: { enabled: true },
    version: 3,
    builtin: false,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

const EMPEROR = contact({
  id: 'ct-emperor',
  name: 'Emperor',
  role: {
    mission: '你是 Emperor。'.repeat(400),
    deliverable: '',
    playbook: '',
    boundaries: '',
    knowledge: [],
  },
  avatar: { kind: 'mascot', pose: 'crown-head' },
  intro: '你的主智能体',
  builtin: true,
  capabilities: {
    model: 'inherit',
    tools: { preset: 'engineer' },
    permission: 'inherit',
  },
})

function listing(): ContactsListing {
  return { contacts: [EMPEROR, contact()], readOnly: null }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

let app: App | null = null
let container: HTMLDivElement | null = null
let router: Router
const ctx = {
  showToast: vi.fn(),
  showError: vi.fn(),
  runSafely: vi.fn(async (task: () => Promise<void>) => await task()),
}

async function mount(path: string) {
  container = document.createElement('div')
  document.body.append(container)
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/chat', component: { render: () => h('div', 'chat') } },
      { path: '/contacts/new', name: 'contact-new', component: ContactEditor },
      {
        path: '/contacts/:id',
        name: 'contact',
        component: { render: () => h('div', 'profile') },
      },
      {
        path: '/contacts/:id/edit',
        name: 'contact-edit',
        component: ContactEditor,
      },
    ],
  })
  await router.push(path)
  app = createApp(() => h(RouterView))
  app.use(router)
  app.provide(APP_CONTEXT_KEY, ctx as never)
  app.mount(container)
  await flush()
}

function q<T extends Element = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector)
  if (!found) throw new Error(`nothing matches ${selector}`)
  return found
}

function button(
  name: string,
  within: ParentNode = document,
): HTMLButtonElement {
  const found = [...within.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === name,
  )
  if (!found) throw new Error(`no button ${name}`)
  return found
}

function field<T extends HTMLInputElement | HTMLTextAreaElement>(
  name: string,
): T {
  return q<T>(`[data-field="${name}"] input, [data-field="${name}"] textarea`)
}

async function type(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  element.value = value
  element.dispatchEvent(new Event('input'))
  await flush()
}

function drafted(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[data-section]')]
    .filter((section) => section.querySelector('[data-ai-drafted]'))
    .map((section) => section.dataset.section ?? '')
}

function calls(op: string): unknown[][] {
  return core.mock.calls.filter((call) => call[0] === op)
}

beforeEach(() => {
  answerConfirmsForTest(() => true)
  ctx.showToast.mockReset()
  ctx.showError.mockReset()
  selectFile.mockReset()
  core.mockReset()
  core.mockImplementation(
    async (op: string, input?: Record<string, unknown>) => {
      switch (op) {
        case 'contacts.list':
          return listing()
        case 'contacts.templates':
          return TEMPLATES
        case 'contacts.get':
          return input?.id === 'ct-emperor' ? EMPEROR : contact()
        case 'contacts.recommendAvatar':
          return { id: 'AV-13-4', theme: 'people' }
        case 'contacts.preview': {
          const draft = (input?.draft ?? {}) as { name?: string }
          const prompt = `# 身份\n\n你是「${draft.name || '新联系人'}」。`
          return {
            prompt,
            chars: Array.from(prompt).length,
            tools: PRESETS.read_only,
            presets: PRESETS,
          }
        }
        case 'model.getConfig':
          return { schemaVersion: 2, activeModelId: null, models: [] }
        case 'sessions.defaults':
          return { permission: 'workspace-write' }
        case 'contacts.create':
          return contact({
            id: 'ct-new000000001',
            name: String(input?.name ?? ''),
          })
        case 'contacts.update':
          return contact()
        default:
          throw new Error(`unexpected ${op}`)
      }
    },
  )
})

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
  answerConfirmsForTest(null)
})

describe('a new contact', () => {
  it('offers the four ways and starts from a template (card test: 四种建法 · 模板)', async () => {
    await mount('/contacts/new')
    const methods = [...document.querySelectorAll<HTMLElement>('[data-method]')]
    expect(methods.map((method) => method.dataset.method)).toEqual([
      'template',
      'brief',
      'import',
      'copy',
    ])
    expect(q('[data-method="template"]').getAttribute('aria-pressed')).toBe(
      'true',
    )
    // The templates in their four groups.
    expect(
      document.querySelector('[data-template-picker]')!.textContent,
    ).toMatch(/软件工程[\s\S]*设计[\s\S]*内容[\s\S]*产品与决策/)
    q('[data-template="security-auditor"] button').click()
    await flush()
    expect(field<HTMLInputElement>('name').value).toBe('安全审计')
    expect(field<HTMLTextAreaElement>('mission').value).toBe('安全审计的职责。')
    expect(field<HTMLTextAreaElement>('playbook').value).toContain('1. 第一步')
    expect(
      q('[data-template="security-auditor"] button').getAttribute(
        'aria-pressed',
      ),
    ).toBe('true')
    // The template's default avatar, unless someone uses it.
    expect(
      q('[data-avatar-recommend] .ds-avatar').getAttribute('data-avatar'),
    ).toBe('AV-01-4')
    // The trial bench gets the template's sample task.
    expect(q<HTMLTextAreaElement>('[data-trial-bench] textarea').value).toBe(
      '安全审计的样例任务',
    )
  })

  it('has the seven sections with character hints (card test: 七节编辑与字数提示)', async () => {
    await mount('/contacts/new')
    const titles = [
      ...document.querySelectorAll<HTMLElement>('[data-section] h3'),
    ].map((title) => title.textContent?.replace(/\s+/g, ' ').trim() ?? '')
    expect(titles.map((title) => title.slice(0, 7))).toEqual([
      expect.stringMatching(/^1 身份/),
      expect.stringMatching(/^2 职责与交付/),
      expect.stringMatching(/^3 工作方法/),
      expect.stringMatching(/^4 知识/),
      expect.stringMatching(/^5 边界/),
      expect.stringMatching(/^6 能力/),
      expect.stringMatching(/^7 群聊习惯/),
    ])
    await type(field('name'), '安全审计')
    expect(q('[data-field="name"]').textContent).toContain('4 / 24')
    await type(field('name'), '长'.repeat(25))
    expect(q('[data-field="name"]').textContent).toContain('超过 1 字')
    await type(field('playbook'), '步'.repeat(10))
    expect(q('[data-field="playbook"]').textContent).toContain('10 / 4000')
  })

  it('drafts from a description: questions first, then 「AI 起草」 marks (card test: 起草追问)', async () => {
    let round = 0
    const base = core.getMockImplementation()!
    core.mockImplementation(
      async (op: string, input?: Record<string, unknown>) => {
        if (op !== 'contacts.draftFromBrief') return base(op, input)
        round += 1
        if (round === 1)
          return {
            kind: 'questions',
            questions: ['审什么代码？', '要不要改代码？'],
            costUsd: 0.0001,
          }
        return {
          kind: 'draft',
          draft: {
            name: '审稿人二号',
            intro: '审 TypeScript 改动',
            domains: ['engineering'],
            role: {
              mission: '审查改动。',
              deliverable: '清单。',
              playbook: '1. 读\n2. 列',
              boundaries: '不改代码。',
              trialTask: '审查这段代码',
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
          costUsd: 0.0002,
        }
      },
    )
    await mount('/contacts/new')
    q('[data-method="brief"]').click()
    await flush()
    await type(q('[data-brief] textarea'), '帮我找个审稿人')
    button('起草').click()
    await flush()
    expect(calls('contacts.draftFromBrief')[0]![1]).toEqual({
      brief: '帮我找个审稿人',
    })
    const questions = [
      ...document.querySelectorAll<HTMLElement>('[data-brief-question]'),
    ]
    expect(questions.map((item) => item.textContent)).toEqual([
      expect.stringContaining('审什么代码？'),
      expect.stringContaining('要不要改代码？'),
    ])
    await type(questions[0]!.querySelector('input')!, 'TypeScript')
    button('交给 Emperor 起草').click()
    await flush()
    expect(calls('contacts.draftFromBrief')[1]![1]).toEqual({
      brief: '帮我找个审稿人',
      answers: [
        { question: '审什么代码？', answer: 'TypeScript' },
        { question: '要不要改代码？', answer: '' },
      ],
    })
    expect(field<HTMLInputElement>('name').value).toBe('审稿人二号')
    expect(drafted().sort()).toEqual(
      [
        'boundaries',
        'capabilities',
        'groupHabit',
        'identity',
        'mission',
        'playbook',
      ].sort(),
    )
    // Changing a section takes its mark away.
    await type(field('boundaries'), '不改代码，也不跑命令。')
    expect(drafted()).not.toContain('boundaries')
    expect(drafted()).toContain('mission')
  })

  it('keeps the description when drafting fails', async () => {
    const base = core.getMockImplementation()!
    core.mockImplementation(
      async (op: string, input?: Record<string, unknown>) => {
        if (op === 'contacts.draftFromBrief')
          throw Object.assign(
            new Error('没能起草岗位说明书：模型没有按格式回答'),
            {
              code: 'contact_draft_failed',
            },
          )
        return base(op, input)
      },
    )
    await mount('/contacts/new')
    q('[data-method="brief"]').click()
    await flush()
    await type(q('[data-brief] textarea'), '帮我找个审稿人')
    button('起草').click()
    await flush()
    expect(q<HTMLTextAreaElement>('[data-brief] textarea').value).toBe(
      '帮我找个审稿人',
    )
    expect(q('[data-brief]').textContent).toContain('没能起草')
  })

  it('imports the file the user picks (card test: 四种建法 · 导入)', async () => {
    selectFile.mockResolvedValue('/Users/me/agents/reviewer.md')
    const base = core.getMockImplementation()!
    core.mockImplementation(
      async (op: string, input?: Record<string, unknown>) => {
        if (op === 'contacts.importAgentFile')
          return {
            draft: {
              name: 'reviewer',
              intro: 'Reviews code',
              domains: [],
              role: {
                mission: '',
                deliverable: '',
                playbook: '1. 读改动\n2. 列问题',
                boundaries: '',
                knowledge: [],
              },
              capabilities: {
                model: 'inherit',
                tools: { preset: 'read_only' },
                permission: 'read_only',
              },
              groupHabit: { speak: 'relevant', length: 'brief' },
            },
            tools: ['glob', 'grep', 'read'],
            unknownTools: ['Task'],
            modelHint: 'opus',
            notes: ['这些工具没有对应的，没有导入：Task。'],
          }
        return base(op, input)
      },
    )
    await mount('/contacts/new')
    q('[data-method="import"]').click()
    await flush()
    button('选择文件…').click()
    await flush()
    expect(calls('contacts.importAgentFile')[0]![1]).toEqual({
      path: '/Users/me/agents/reviewer.md',
    })
    expect(field<HTMLInputElement>('name').value).toBe('reviewer')
    expect(field<HTMLTextAreaElement>('playbook').value).toBe(
      '1. 读改动\n2. 列问题',
    )
    expect(q('[data-import-notes]').textContent).toContain('Task')
    // Nothing is saved yet.
    expect(calls('contacts.create')).toHaveLength(0)
  })

  it('copies a contact under a new name (card test: 四种建法 · 复制)', async () => {
    await mount('/contacts/new')
    q('[data-method="copy"]').click()
    await flush()
    // Builtins are not offered.
    expect(document.querySelector('[data-copy-source="ct-emperor"]')).toBeNull()
    q('[data-copy-source="ct-reviewer00001"] button').click()
    await flush()
    expect(field<HTMLInputElement>('name').value).toBe('审稿人 副本')
    expect(field<HTMLTextAreaElement>('mission').value).toBe('审查改动。')
  })

  it('shows the compiled prompt and the completeness of the draft', async () => {
    await mount('/contacts/new')
    q('[data-template="security-auditor"] button').click()
    await flush()
    await new Promise((resolve) => setTimeout(resolve, 450))
    await flush()
    expect(q('[data-compiled-prompt]').textContent).toContain(
      '你是「安全审计」',
    )
    const preview = calls('contacts.preview').at(-1)![1] as {
      draft: Record<string, unknown>
    }
    expect(preview.draft).toMatchObject({
      name: '安全审计',
      templateId: 'security-auditor',
    })
    expect(preview.draft).not.toHaveProperty('id')
    const checks = [
      ...document.querySelectorAll<HTMLElement>('[data-check]'),
    ].map((item) => [item.dataset.check, item.dataset.done])
    expect(checks).toEqual([
      ['deliverable', 'true'],
      ['playbook', 'true'],
      ['boundaries', 'true'],
      ['tools', 'true'],
      ['trial', 'false'],
    ])
    expect(q('[data-completeness]').textContent).toContain('4 / 5')
  })

  it('saves with the avatar shown and moves to the saved contact’s profile (GRP-05)', async () => {
    await mount('/contacts/new')
    q('[data-template="security-auditor"] button').click()
    await flush()
    button('保存联系人').click()
    await flush()
    const [, input] = calls('contacts.create')[0]!
    expect(input).toMatchObject({
      name: '安全审计',
      kind: 'local',
      templateId: 'security-auditor',
      avatar: { kind: 'library', id: 'AV-01-4' },
      role: { mission: '安全审计的职责。' },
    })
    expect(ctx.showToast).toHaveBeenCalledWith(
      expect.stringContaining('已保存'),
    )
    expect(router.currentRoute.value.fullPath).toBe('/contacts/ct-new000000001')
  })

  it('recommends a person, an animal or a robot for a blank contact', async () => {
    await mount('/contacts/new')
    q('[data-method="brief"]').click()
    await flush()
    expect(calls('contacts.recommendAvatar')[0]![1]).toEqual({})
    expect(
      q('[data-avatar-recommend] .ds-avatar').getAttribute('data-avatar'),
    ).toBe('AV-13-4')
  })
})

describe('editing a saved contact', () => {
  it('loads it and saves the change as an update', async () => {
    await mount('/contacts/ct-reviewer00001/edit')
    expect(document.querySelector('[data-contact-methods]')).toBeNull()
    expect(field<HTMLInputElement>('name').value).toBe('审稿人')
    await type(field('intro'), '只看安全问题')
    button('保存联系人').click()
    await flush()
    const [, input] = calls('contacts.update')[0]!
    expect(input).toMatchObject({
      id: 'ct-reviewer00001',
      patch: { intro: '只看安全问题', name: '审稿人' },
    })
  })

  it('lets a builtin change only its avatar and intro', async () => {
    await mount('/contacts/ct-emperor/edit')
    expect(q('[data-contact-editor]').textContent).toContain(
      '内置联系人只能改头像和简介',
    )
    expect(
      field<HTMLInputElement>('name').disabled ||
        field<HTMLInputElement>('name').readOnly,
    ).toBe(true)
    // Its shipped card is not shown (Emperor's is the long persona).
    expect(
      [...document.querySelectorAll<HTMLElement>('[data-section]')].map(
        (section) => section.dataset.section,
      ),
    ).toEqual(['identity'])
    await type(field('intro'), '统筹一切')
    button('保存联系人').click()
    await flush()
    expect(calls('contacts.update')[0]![1]).toEqual({
      id: 'ct-emperor',
      patch: {
        avatar: { kind: 'mascot', pose: 'crown-head' },
        intro: '统筹一切',
      },
    })
  })
})
