// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CodeEditor,
  DefinitionList,
  EmptyState,
  Field,
  Metric,
  SearchField,
  Segmented,
  Select,
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  StatusBadge,
  Switch,
  TextArea,
  TextField,
} from './index'

let app: App | null = null
let container: HTMLDivElement | null = null

function mount(render: () => ReturnType<typeof h>) {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp(defineComponent({ render }))
  app.mount(container)
  return container
}

async function flush() {
  await nextTick()
  await nextTick()
}

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  document.body.innerHTML = ''
})

describe('layout primitives', () => {
  it('composes section, group and rows with label wiring', () => {
    const root = mount(() =>
      h(
        SettingsSection,
        { intro: '说明' },
        {
          default: () => [
            h(SettingsRow, { title: '主题', labelFor: 'theme-select' }, () =>
              h('button', { id: 'theme-select' }, 'x'),
            ),
            h(
              SettingsGroup,
              { title: '策略', description: '说明文字' },
              {
                default: () =>
                  h(SettingsRow, { title: '回退', layout: 'stacked' }),
                actions: () => h('button', { class: 'group-action' }, '加'),
              },
            ),
          ],
        },
      ),
    )
    expect(root.querySelector('.intro')?.textContent).toBe('说明')
    const label = root.querySelector('label.title')
    expect(label?.getAttribute('for')).toBe('theme-select')
    expect(root.querySelector('h3.title')?.textContent).toBe('策略')
    expect(root.querySelector('.group-action')).not.toBeNull()
    expect(
      root.querySelectorAll('.ds-settings-row')[1]?.getAttribute('data-layout'),
    ).toBe('stacked')
  })

  it('expands a card from its header but not from its actions', async () => {
    const open = ref(false)
    const onAction = vi.fn()
    const root = mount(() =>
      h(
        SettingsCard,
        {
          title: 'aihot',
          description: '12 个工具',
          expandable: true,
          open: open.value,
          'onUpdate:open': (value: boolean) => (open.value = value),
        },
        {
          default: () => h('p', { class: 'card-body' }, 'body'),
          actions: () => h('button', { class: 'act', onClick: onAction }, '删'),
          footer: () => h('button', { class: 'save' }, '保存'),
        },
      ),
    )
    const toggle = root.querySelector<HTMLButtonElement>('button.head-text')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(root.querySelector('.card-body')).toBeNull()
    expect(root.querySelector('.save')).toBeNull()

    root.querySelector<HTMLButtonElement>('.act')!.click()
    await flush()
    expect(onAction).toHaveBeenCalled()
    expect(open.value).toBe(false)

    toggle.click()
    await flush()
    expect(open.value).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const body = root.querySelector('.card-body')?.parentElement
    expect(body?.id).toBe(toggle.getAttribute('aria-controls'))
    expect(root.querySelector('.save')).not.toBeNull()
  })
})

describe('SettingsCard slots', () => {
  it('shows a body and header slots the parent adds after mount', async () => {
    const editing = ref(false)
    const withLeading = ref(false)
    const root = mount(() =>
      h(SettingsCard, null, {
        ...(withLeading.value
          ? { leading: () => h('i', { class: 'glyph' }) }
          : {}),
        ...(editing.value
          ? { default: () => h('p', { class: 'late-body' }, 'editor') }
          : {}),
      }),
    )
    expect(root.querySelector('.head')).toBeNull()
    expect(root.querySelector('.late-body')).toBeNull()

    editing.value = true
    withLeading.value = true
    await flush()
    expect(root.querySelector('.head .glyph')).not.toBeNull()
    const body = root.querySelector('.late-body')?.parentElement
    expect(body?.classList.contains('body')).toBe(true)
    expect(body?.hasAttribute('data-after-head')).toBe(true)

    editing.value = false
    await flush()
    expect(root.querySelector('.late-body')).toBeNull()
    expect(root.querySelector('.body')).toBeNull()
  })
})

describe('form primitives', () => {
  it('Field wires label, hint and error into the control', async () => {
    const value = ref('ftp://x')
    const error = ref<string | undefined>('只支持 http')
    const root = mount(() =>
      h(Field, { label: 'URL', hint: '提示', error: error.value }, () =>
        h(TextField, {
          modelValue: value.value,
          'onUpdate:modelValue': (next: string) => (value.value = next),
        }),
      ),
    )
    const input = root.querySelector('input')!
    const label = root.querySelector('label')!
    expect(label.getAttribute('for')).toBe(input.id)
    expect(input.getAttribute('aria-invalid')).toBe('true')
    const hint = root.querySelector('.hint')!
    expect(input.getAttribute('aria-describedby')).toBe(hint.id)
    expect(hint.textContent).toBe('只支持 http')

    input.value = 'https://ok'
    input.dispatchEvent(new Event('input'))
    await flush()
    expect(value.value).toBe('https://ok')

    error.value = undefined
    await flush()
    expect(input.getAttribute('aria-invalid')).toBeNull()
    expect(root.querySelector('.hint')?.textContent).toBe('提示')
  })

  it('TextField forwards listeners to the input and class to the box', () => {
    const onEnter = vi.fn()
    const root = mount(() =>
      h(TextField, { class: 'probe', onKeydown: onEnter, modelValue: '' }),
    )
    expect(root.querySelector('.ds-text-field')?.classList).toContain('probe')
    root
      .querySelector('input')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(onEnter).toHaveBeenCalled()
  })

  it('TextArea sizes its rows from content within bounds', () => {
    const root = mount(() =>
      h(TextArea, { modelValue: 'a\nb\nc\nd\ne', minRows: 2, maxRows: 4 }),
    )
    expect(root.querySelector('textarea')?.getAttribute('rows')).toBe('4')
  })

  it('CodeEditor numbers lines and emits save on Mod+S', async () => {
    const onSave = vi.fn()
    const root = mount(() =>
      h(CodeEditor, {
        modelValue: '{\n  "a": 1\n}',
        ariaLabel: 'hooks.json',
        onSave,
      }),
    )
    expect(root.querySelector('.gutter-lines')?.textContent).toBe('1\n2\n3')
    const textarea = root.querySelector('textarea')!
    expect(textarea.getAttribute('aria-label')).toBe('hooks.json')
    expect(textarea.getAttribute('wrap')).toBe('off')
    const event = new KeyboardEvent('keydown', {
      key: 's',
      metaKey: true,
      cancelable: true,
    })
    textarea.dispatchEvent(event)
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('Switch toggles through click with role=switch', async () => {
    const on = ref(false)
    const root = mount(() =>
      h(Switch, {
        modelValue: on.value,
        ariaLabel: '启用',
        'onUpdate:modelValue': (value: boolean) => (on.value = value),
      }),
    )
    const button = root.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect(button.getAttribute('aria-checked')).toBe('false')
    button.click()
    await flush()
    expect(on.value).toBe(true)
    expect(button.getAttribute('aria-checked')).toBe('true')
  })

  it('Segmented moves selection with arrow keys (roving tabindex)', async () => {
    const value = ref('7d')
    const root = mount(() =>
      h(Segmented, {
        modelValue: value.value,
        'onUpdate:modelValue': (next: string) => (value.value = next),
        ariaLabel: '范围',
        options: [
          { value: '7d', label: '7 天' },
          { value: '30d', label: '30 天', disabled: true },
          { value: 'all', label: '全部' },
        ],
      }),
    )
    const radios = [
      ...root.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    ]
    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1])
    radios[0].dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    )
    await flush()
    expect(value.value).toBe('all')
    expect(radios[2].getAttribute('aria-checked')).toBe('true')
  })

  it('Select opens a menu, focuses the current option and picks with the keyboard', async () => {
    const value = ref('b')
    const onChange = vi.fn()
    const root = mount(() =>
      h(Select, {
        modelValue: value.value,
        'onUpdate:modelValue': (next: string) => (value.value = next),
        onChange,
        ariaLabel: '强度',
        options: [
          { value: 'a', label: '低' },
          { value: 'b', label: '中', description: '默认' },
          { value: 'c', label: '高' },
        ],
      }),
    )
    const trigger = root.querySelector<HTMLButtonElement>('.ds-select')!
    expect(trigger.textContent).toContain('中')
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    await flush()
    await flush()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const items = [
      ...document.body.querySelectorAll<HTMLButtonElement>(
        '[role="menu"] [role="menuitem"]',
      ),
    ]
    expect(items).toHaveLength(3)
    expect(document.activeElement).toBe(items[1])
    items[1].dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    )
    expect(document.activeElement).toBe(items[2])
    items[2].click()
    await flush()
    expect(value.value).toBe('c')
    expect(onChange).toHaveBeenCalledWith('c')
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('SearchField clears on Escape without letting the modal close', async () => {
    const query = ref('mcp')
    const outer = vi.fn()
    document.addEventListener('keydown', outer)
    const root = mount(() =>
      h(SearchField, {
        modelValue: query.value,
        'onUpdate:modelValue': (next: string) => (query.value = next),
      }),
    )
    const input = root.querySelector('input')!
    expect(input.getAttribute('aria-label')).toBe('搜索')
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    await flush()
    expect(query.value).toBe('')
    expect(outer).not.toHaveBeenCalled()
    document.removeEventListener('keydown', outer)
  })
})

describe('display primitives', () => {
  it('renders definitions, badges, metrics and empty states', () => {
    const root = mount(() =>
      h('div', [
        h(DefinitionList, {
          items: [
            { term: 'URL', value: 'https://x', mono: true },
            { term: '错误', value: null },
          ],
        }),
        h(StatusBadge, { tone: 'ok', dot: true }, () => '已连接'),
        h(Metric, { label: '请求', value: 12, unit: '次', tone: 'error' }),
        h(EmptyState, { title: '暂无', description: '去添加' }),
      ]),
    )
    const values = [...root.querySelectorAll('dd')].map((dd) =>
      dd.textContent?.trim(),
    )
    expect(values).toEqual(['https://x', '—'])
    expect(root.querySelector('dd')?.dataset.mono).toBe('true')
    const badge = root.querySelector('.ds-status-badge')!
    expect(badge.getAttribute('data-tone')).toBe('ok')
    expect(badge.querySelector('.badge-dot')).not.toBeNull()
    expect(root.querySelector('.ds-metric .value')?.textContent).toContain('12')
    expect(root.querySelector('.ds-empty-state .title')?.textContent).toBe(
      '暂无',
    )
  })
})
