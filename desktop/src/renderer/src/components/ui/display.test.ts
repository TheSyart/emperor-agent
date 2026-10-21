// @vitest-environment jsdom
// DS-04 (PLAN-V020): display, input and surface components — Badge, Tag,
// Dot, Avatar, ListRow, Surface, List / ListSection, EmptyState, Notice,
// Checkbox, TextField, TextArea, SearchField, Select, Segmented, Switch,
// Field, Tabs and PaneHeader — and the behaviour the plan's tests 1–10 ask
// for.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createApp, h, nextTick, ref, type Component } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Avatar from './Avatar.vue'
import Badge from './Badge.vue'
import Checkbox from './Checkbox.vue'
import Dot from './Dot.vue'
import EmptyState from './EmptyState.vue'
import Field from './Field.vue'
import List from './List.vue'
import ListRow from './ListRow.vue'
import ListSection from './ListSection.vue'
import Notice from './Notice.vue'
import PaneHeader from './PaneHeader.vue'
import SearchField from './SearchField.vue'
import Segmented from './Segmented.vue'
import Select from './Select.vue'
import Surface from './Surface.vue'
import Switch from './Switch.vue'
import Tabs from './Tabs.vue'
import Tag from './Tag.vue'
import TextArea from './TextArea.vue'
import TextField from './TextField.vue'
import { AVATAR_SIZES } from './avatar'
import { dotFromStatus } from './dot'
import { SUBAGENT_PORTRAITS, subagentPortrait } from './subagentPortraits'
import { clearSpriteCache, portraitLayout } from './spriteAvatar'
import { avatarSeed } from '../workspace/environmentModel'

let container: HTMLDivElement | null = null
let app: ReturnType<typeof createApp> | null = null

function mount(render: () => ReturnType<typeof h>) {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp(render)
  app.config.warnHandler = () => undefined
  app.mount(container)
  return container
}

function key(target: Element, name: string) {
  const event = new KeyboardEvent('keydown', {
    key: name,
    bubbles: true,
    cancelable: true,
  })
  target.dispatchEvent(event)
  return event
}

async function flush() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve()
    await nextTick()
  }
}

async function source(name: string): Promise<string> {
  const modules = import.meta.glob('./*.vue', {
    query: '?raw',
    import: 'default',
  })
  return (await modules[`./${name}.vue`]!()) as string
}

beforeEach(() => {
  clearSpriteCache()
})

afterEach(() => {
  app?.unmount()
  container?.remove()
  container = null
  app = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

// ── Test 1: every component's props, as a snapshot ────────────────────────

describe('props snapshot (test 1)', () => {
  function describeEl(el: Element | null): string {
    if (!el) return '∅'
    const data = Object.entries((el as HTMLElement).dataset)
      // Scoped-style markers (data-v-<hash>) are not props.
      .filter(([name]) => !/^v(?:-[0-9a-f]|[A-F])[0-9a-f]*$/.test(name))
      .map(([name, value]) => (value ? `${name}=${value}` : name))
      .sort()
      .join(' ')
    const role = el.getAttribute('role')
    const text = el.textContent?.replace(/\s+/g, ' ').trim()
    return [
      el.className.toString().split(' ')[0],
      role ? `role=${role}` : '',
      data,
      text ? `"${text}"` : '',
    ]
      .filter(Boolean)
      .join(' ')
  }

  it('Badge: seven tones, three variants, height 18', async () => {
    const tones = [
      'neutral',
      'accent',
      'ok',
      'warn',
      'error',
      'attention',
      'info',
    ] as const
    const root = mount(() =>
      h('div', [
        ...tones.map((tone) => h(Badge, { tone }, () => tone)),
        h(Badge, { variant: 'count', label: 12 }),
        h(Badge, { variant: 'dot-label', tone: 'ok' }, () => '已连接'),
        h(Badge, { mono: true }, () => 'stdio'),
      ]),
    )
    expect(
      [...root.querySelectorAll('.ds-badge')].map(describeEl),
    ).toMatchSnapshot()
    expect(
      root.querySelector('[data-variant="dot-label"] .badge-dot'),
    ).not.toBe(null)
    expect(await source('Badge')).toMatch(/height:\s*var\(--badge-h\)/)
  })

  it('Tag, Dot and Avatar', () => {
    const root = mount(() =>
      h('div', [
        h(Tag, { label: '筛选' }),
        h(Tag, { label: '已选', selected: true }),
        h(Tag, { label: 'README.md', removable: true }),
        ...(
          ['ok', 'warn', 'error', 'running', 'idle', 'attention'] as const
        ).map((state) => h(Dot, { state })),
        h(Dot, { state: 'ok', size: 'sm', label: '已完成' }),
        h(Avatar, { kind: 'initials', label: 'GitHub', size: 28 }),
        h(Avatar, { kind: 'color', label: '设计', id: 'designer', size: 20 }),
        h(Avatar, { kind: 'logo', label: 'OpenAI', iconId: 'openai' }),
        h(Avatar, {
          kind: 'logo',
          label: 'GitHub',
          src: 'app://plugin-assets/managed/github/logo?v=1',
          size: 40,
        }),
        h(Avatar, { kind: 'sprite', id: 'child-0', size: 16 }),
      ]),
    )
    expect(
      [...root.querySelectorAll('.ds-tag, .ds-dot, .ds-avatar')].map(
        describeEl,
      ),
    ).toMatchSnapshot()
    expect(AVATAR_SIZES).toEqual([16, 20, 24, 28, 40])
  })

  it('ListRow, Surface, List, ListSection, EmptyState and Notice', () => {
    const root = mount(() =>
      h('div', [
        h(List, { label: '会话' }, () => [
          h(ListSection, { title: '今天' }, () => [
            h(ListRow, { title: '默认', size: 'sm' }),
            h(ListRow, { title: '选中', size: 'md', selected: true }),
            h(ListRow, { title: '子项', size: 'lg', nested: true }),
            h(ListRow, { title: '删除', danger: true }),
          ]),
        ]),
        ...(['raised', 'sunken', 'overlay'] as const).map((tone) =>
          h(Surface, { tone }, () => tone),
        ),
        h(Surface, { pad: 'none', radius: 'lg', interactive: true }, () => 'x'),
        h(EmptyState, { title: '暂无对话' }),
        h(EmptyState, { title: '没有匹配', variant: 'inline' }),
        ...(
          [
            'neutral',
            'accent',
            'ok',
            'warn',
            'error',
            'attention',
            'info',
          ] as const
        ).map((tone) => h(Notice, { tone, title: `${tone} 提示` })),
      ]),
    )
    expect(
      [
        ...root.querySelectorAll(
          '.ds-list, .ds-list-section, .ds-list-row, .ds-surface, .ds-empty-state, .ds-notice',
        ),
      ].map(describeEl),
    ).toMatchSnapshot()
  })

  it('inputs: Checkbox, TextField, TextArea, SearchField, Select, Segmented, Switch, Field', () => {
    const root = mount(() =>
      h('div', [
        h(Checkbox, { modelValue: true }, () => '记住'),
        h(Field, { label: '名称', hint: '最多 120 字' }, () =>
          h(TextField, { modelValue: 'a', placeholder: '名称' }),
        ),
        h(TextField, { modelValue: '', size: 'sm', invalid: true }),
        h(TextArea, { modelValue: '一\n二' }),
        h(SearchField, { modelValue: '' }),
        h(Select, {
          modelValue: 'a',
          options: [
            { value: 'a', label: '甲' },
            { value: 'b', label: '乙' },
          ],
          ariaLabel: '选项',
        }),
        h(Segmented, {
          modelValue: 'day',
          options: [
            { value: 'day', label: '日' },
            { value: 'week', label: '周' },
          ],
          ariaLabel: '范围',
        }),
        h(Switch, { modelValue: true, ariaLabel: '启用' }),
      ]),
    )
    expect(
      [
        ...root.querySelectorAll(
          '.ds-checkbox, .ds-field, .ds-text-field, .ds-text-area, .ds-search-field, .ds-select, .ds-tabs, .ds-switch',
        ),
      ].map(describeEl),
    ).toMatchSnapshot()
  })

  it('inputs share the 32px height, r-sm corners and the focus ring', async () => {
    for (const name of ['TextField', 'SearchField', 'Select']) {
      const css = await source(name)
      expect(css, name).toMatch(/height:\s*var\(--field-h\)/)
      expect(css, name).toMatch(/border-radius:\s*var\(--r-sm\)/)
    }
    for (const name of [
      'Tag',
      'ListRow',
      'Checkbox',
      'TextField',
      'TextArea',
      'SearchField',
      'Select',
      'Switch',
      'Tabs',
      'Surface',
    ])
      expect(await source(name), name).toMatch(
        /:focus(?:-visible|-within)?[\s\S]*?var\(--focus-ring\)/,
      )
  })

  it('maps run statuses onto dot states', () => {
    expect(dotFromStatus('running')).toBe('running')
    expect(dotFromStatus('pending')).toBe('running')
    expect(dotFromStatus('failed')).toBe('error')
    expect(dotFromStatus('interrupted')).toBe('warn')
    expect(dotFromStatus('idle')).toBe('idle')
    expect(dotFromStatus(undefined)).toBe('ok')
  })
})

// ── Test 2: ListRow trailing actions only on hover and keyboard focus ────

describe('ListRow trailing actions (test 2)', () => {
  it('shows trailing actions while hovered or focused, hides them otherwise', async () => {
    const root = mount(() =>
      h(
        ListRow,
        { title: '会话标题' },
        {
          trailing: () => h('button', { class: 'probe' }, '更多'),
        },
      ),
    )
    const row = root.querySelector<HTMLElement>('.ds-list-row')!
    const trailing = row.querySelector('.trailing')!
    expect(trailing.querySelector('.probe')).not.toBeNull()
    expect(row.hasAttribute('data-reveal')).toBe(false)

    row.dispatchEvent(new Event('pointerenter'))
    await nextTick()
    expect(row.hasAttribute('data-reveal')).toBe(true)
    row.dispatchEvent(new Event('pointerleave'))
    await nextTick()
    expect(row.hasAttribute('data-reveal')).toBe(false)

    row.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    await nextTick()
    expect(row.hasAttribute('data-reveal')).toBe(true)
    row.dispatchEvent(
      new FocusEvent('focusout', { bubbles: true, relatedTarget: null }),
    )
    await nextTick()
    expect(row.hasAttribute('data-reveal')).toBe(false)

    const css = await source('ListRow')
    expect(css).toMatch(/\.trailing\s*\{[^}]*opacity:\s*0/)
    expect(css).toMatch(/\[data-reveal\]\s*\.trailing\s*\{[^}]*opacity:\s*1/)
  })

  it('keeps the actions visible while focus moves into them', async () => {
    const root = mount(() =>
      h(
        ListRow,
        { title: '会话' },
        { trailing: () => h('button', { class: 'probe' }, '更多') },
      ),
    )
    const row = root.querySelector<HTMLElement>('.ds-list-row')!
    const probe = row.querySelector<HTMLButtonElement>('.probe')!
    row.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    row.dispatchEvent(
      new FocusEvent('focusout', { bubbles: true, relatedTarget: probe }),
    )
    await nextTick()
    expect(row.hasAttribute('data-reveal')).toBe(true)
  })
})

// ── Test 3: ListRow arrow keys and Enter ─────────────────────────────────

describe('ListRow keyboard (test 3)', () => {
  it('moves with ArrowUp / ArrowDown / Home / End and selects with Enter', async () => {
    const picked: string[] = []
    const root = mount(() =>
      h(List, { label: '会话' }, () =>
        ['甲', '乙', '丙', '丁'].map((title, index) =>
          h(ListRow, {
            title,
            disabled: index === 2,
            onSelect: () => picked.push(title),
          }),
        ),
      ),
    )
    const rows = [...root.querySelectorAll<HTMLElement>('.ds-list-row')]
    expect(root.querySelector('.ds-list')?.getAttribute('role')).toBe('listbox')
    expect(rows.map((row) => row.getAttribute('role'))).toEqual([
      'option',
      'option',
      'option',
      'option',
    ])
    rows[0]!.focus()
    key(rows[0]!, 'ArrowDown')
    expect(document.activeElement).toBe(rows[1])
    // The disabled row is skipped.
    key(rows[1]!, 'ArrowDown')
    expect(document.activeElement).toBe(rows[3])
    key(rows[3]!, 'ArrowUp')
    expect(document.activeElement).toBe(rows[1])
    key(rows[1]!, 'Home')
    expect(document.activeElement).toBe(rows[0])
    key(rows[0]!, 'End')
    expect(document.activeElement).toBe(rows[3])

    const enter = key(rows[3]!, 'Enter')
    expect(enter.defaultPrevented).toBe(true)
    key(rows[1]!, ' ')
    rows[0]!.click()
    key(rows[2]!, 'Enter')
    await nextTick()
    expect(picked).toEqual(['丁', '乙', '甲'])
  })

  it('does not steal arrow keys or Enter from a control inside the row', () => {
    const onSelect = vi.fn()
    const root = mount(() =>
      h(List, null, () => [
        h(
          ListRow,
          { title: '甲', onSelect },
          {
            trailing: () => h('input', { class: 'inner' }),
          },
        ),
        h(ListRow, { title: '乙' }),
      ]),
    )
    const inner = root.querySelector<HTMLInputElement>('.inner')!
    inner.focus()
    key(inner, 'ArrowDown')
    key(inner, 'Enter')
    expect(document.activeElement).toBe(inner)
    expect(onSelect).not.toHaveBeenCalled()
  })
})

// ── Test 4: Tag removal from the keyboard ─────────────────────────────────

describe('Tag (test 4)', () => {
  it('a removable tag is removed with Backspace, Delete or its × button', () => {
    const onRemove = vi.fn()
    const root = mount(() =>
      h(
        Tag,
        { label: 'README.md', removable: true, onRemove },
        {
          leading: () => h('img', { class: 'thumb', alt: '' }),
        },
      ),
    )
    const body = root.querySelector<HTMLButtonElement>('.ds-tag .body')!
    expect(root.querySelector('.ds-tag .thumb')).not.toBeNull()
    body.focus()
    expect(key(body, 'Backspace').defaultPrevented).toBe(true)
    key(body, 'Delete')
    const remove = root.querySelector<HTMLButtonElement>('.ds-tag .remove')!
    expect(remove.getAttribute('aria-label')).toBe('移除 README.md')
    remove.click()
    expect(onRemove).toHaveBeenCalledTimes(3)
  })

  it('a plain tag ignores Backspace and reports selection with aria-pressed', () => {
    const onRemove = vi.fn()
    const onClick = vi.fn()
    const root = mount(() =>
      h(Tag, { label: '筛选', selected: true, onRemove, onClick }),
    )
    const body = root.querySelector<HTMLButtonElement>('.ds-tag .body')!
    key(body, 'Backspace')
    expect(onRemove).not.toHaveBeenCalled()
    expect(root.querySelector('.ds-tag .remove')).toBeNull()
    expect(body.getAttribute('aria-pressed')).toBe('true')
    body.click()
    expect(onClick).toHaveBeenCalledOnce()
  })
})

// ── Test 5: Avatar sprites decode only the rendered size ──────────────────

describe('Avatar sprite (test 5)', () => {
  function stubCanvas() {
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () =>
        ({
          drawImage,
          clearRect: vi.fn(),
          imageSmoothingEnabled: true,
          imageSmoothingQuality: 'low',
        }) as unknown as CanvasRenderingContext2D,
    )
    const createImageBitmap = vi.fn(
      async (
        _source: unknown,
        _sx: number,
        _sy: number,
        _sw: number,
        _sh: number,
        options: { resizeWidth: number; resizeHeight: number },
      ) => ({
        width: options.resizeWidth,
        height: options.resizeHeight,
        close: vi.fn(),
      }),
    )
    vi.stubGlobal('createImageBitmap', createImageBitmap)
    vi.stubGlobal(
      'Image',
      class {
        src = ''
        decoding = ''
        naturalWidth = 448
        naturalHeight = 448
        decode() {
          return Promise.resolve()
        }
      },
    )
    vi.stubGlobal('devicePixelRatio', 2)
    return { drawImage, createImageBitmap }
  }

  it('crops the portrait at size × devicePixelRatio, never the whole sheet', async () => {
    const { drawImage, createImageBitmap } = stubCanvas()
    let id = 0
    while (avatarSeed(`chameleon-${id}`) % 36 !== 34) id++
    const portrait = subagentPortrait(avatarSeed(`chameleon-${id}`))
    expect(portrait.id).toBe('D08')
    const root = mount(() =>
      h(Avatar, { kind: 'sprite', id: `chameleon-${id}`, size: 24 }),
    )
    await flush()
    const avatar = root.querySelector<HTMLElement>('.ds-avatar')!
    expect(avatar.dataset.avatar).toBe('D08')
    const canvas = avatar.querySelector('canvas')!
    expect(canvas.width).toBe(48)
    expect(canvas.height).toBe(48)
    expect(avatar.style.width).toBe('24px')
    // No <image>/<img> holding the whole sheet in the DOM.
    expect(root.querySelector('image, img')).toBeNull()

    expect(createImageBitmap).toHaveBeenCalledOnce()
    const [, sx, sy, sw, sh, options] = createImageBitmap.mock.calls[0]!
    expect([sx, sy, sw, sh]).toEqual([174, 297, 108, 126])
    const layout = portraitLayout(
      portrait.rect as [number, number, number, number],
      48,
    )
    expect(options).toMatchObject({
      resizeWidth: layout.width,
      resizeHeight: layout.height,
    })
    expect(layout.width).toBeLessThanOrEqual(48)
    expect(layout.height).toBeLessThanOrEqual(48)
    expect(drawImage).toHaveBeenCalledWith(
      expect.objectContaining({ width: layout.width }),
      layout.x,
      layout.y,
    )
  })

  it('keeps 3% room and the aspect of the measured window (UI-S13)', () => {
    // 108 × 126 fitted into the 94% content box of 100 device pixels.
    const layout = portraitLayout([174, 297, 108, 126], 100)
    expect(layout.height).toBe(94)
    expect(layout.width).toBe(Math.round((94 * 108) / 126))
    expect(layout.y).toBe(3)
    expect(layout.x).toBe(Math.round((100 - layout.width) / 2))
  })

  it('shares one decode between avatars of the same portrait and size', async () => {
    const { createImageBitmap } = stubCanvas()
    mount(() =>
      h('div', [
        h(Avatar, { kind: 'sprite', id: 'same-agent', size: 20 }),
        h(Avatar, { kind: 'sprite', id: 'same-agent', size: 20 }),
      ]),
    )
    await flush()
    expect(createImageBitmap).toHaveBeenCalledOnce()
  })

  it('keeps a child identity stable across status updates, over all 36 portraits', async () => {
    const id = ref('child-0')
    const status = ref('running')
    const root = mount(() =>
      h(Avatar, { kind: 'sprite', id: id.value, status: status.value }),
    )
    const character = () =>
      root.querySelector('[data-avatar]')!.getAttribute('data-avatar')
    const first = character()
    status.value = 'completed'
    await nextTick()
    expect(character()).toBe(first)
    expect(root.querySelector('[data-status="completed"]')).not.toBeNull()
    const kinds = new Set<string | null>()
    for (let i = 0; i < 300; i++) {
      id.value = `child-${i}`
      await nextTick()
      kinds.add(character())
    }
    expect(kinds.size).toBe(SUBAGENT_PORTRAITS.length)
    expect(kinds.size).toBe(36)
  })

  it('logo: shows the host image, and the colour tile with the initial when it breaks', async () => {
    const root = mount(() =>
      h(Avatar, {
        kind: 'logo',
        label: 'GitHub',
        src: 'app://plugin-assets/managed/github/logo?v=1',
        size: 40,
      }),
    )
    const image = root.querySelector<HTMLImageElement>('.ds-avatar img')!
    expect(image.getAttribute('src')).toBe(
      'app://plugin-assets/managed/github/logo?v=1',
    )
    expect(root.querySelector('.ds-avatar')?.getAttribute('aria-hidden')).toBe(
      'true',
    )
    image.dispatchEvent(new Event('error'))
    await nextTick()
    const tile = root.querySelector<HTMLElement>('.ds-avatar')!
    expect(tile.dataset.shown).toBe('color')
    expect(tile.textContent?.trim()).toBe('G')
    expect(root.querySelector('img')).toBeNull()
  })

  it('logo: a provider without an upstream logo draws its first letter', () => {
    const root = mount(() =>
      h(Avatar, { kind: 'logo', label: 'my gateway', iconId: 'nope-xyz' }),
    )
    expect(root.querySelector('.ds-avatar')?.textContent?.trim()).toBe('M')
  })

  it('refuses off-scale sizes in development', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const root = mount(() =>
      h(Avatar as Component, { kind: 'initials', label: 'A', size: 22 }),
    )
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Avatar size'))
    expect(root.querySelector('.ds-avatar')?.getAttribute('data-size')).toBe(
      '24',
    )
  })
})

// ── Test 6: EmptyState block and inline ───────────────────────────────────

describe('EmptyState (test 6)', () => {
  it('block: 20px icon, title, description and actions, centred', () => {
    const Glyph = (props: { size?: number }) =>
      h('svg', { class: 'glyph', width: props.size })
    const root = mount(() =>
      h(
        EmptyState,
        {
          title: '暂无定时任务',
          description: '新建一个任务开始。',
          icon: Glyph,
        },
        () => h('button', { class: 'action' }, '新建'),
      ),
    )
    const empty = root.querySelector<HTMLElement>('.ds-empty-state')!
    expect(empty.dataset.variant).toBe('block')
    expect(empty.querySelector('.glyph')?.getAttribute('width')).toBe('20')
    expect(empty.querySelector('.title')?.textContent).toBe('暂无定时任务')
    expect(empty.querySelector('.description')?.textContent).toBe(
      '新建一个任务开始。',
    )
    expect(empty.querySelector('.actions .action')).not.toBeNull()
  })

  it('inline: a single line with no icon block or actions row', () => {
    const root = mount(() =>
      h(EmptyState, {
        title: '没有匹配的会话',
        description: '换个关键词试试',
        variant: 'inline',
      }),
    )
    const empty = root.querySelector<HTMLElement>('.ds-empty-state')!
    expect(empty.dataset.variant).toBe('inline')
    expect(empty.textContent?.replace(/\s+/g, '')).toBe(
      '没有匹配的会话换个关键词试试',
    )
    expect(empty.querySelector('.actions')).toBeNull()
  })
})

// ── Test 7: Tabs keyboard navigation in all three variants ───────────────

describe('Tabs (test 7)', () => {
  it.each(['underline', 'segmented', 'editor'] as const)(
    '%s: ArrowLeft / ArrowRight / Home / End move, select and skip disabled tabs',
    async (variant) => {
      const active = ref('a')
      const root = mount(() =>
        h(Tabs, {
          variant,
          tabs: [
            { id: 'a', label: '对话' },
            { id: 'b', label: '轨迹' },
            { id: 'c', label: '停用', disabled: true },
            { id: 'd', label: '文件' },
          ],
          modelValue: active.value,
          'onUpdate:modelValue': (value: string) => (active.value = value),
        }),
      )
      const list = root.querySelector<HTMLElement>('.ds-tabs')!
      expect(list.dataset.variant).toBe(variant)
      expect(list.getAttribute('role')).toBe('tablist')
      const tabs = () => [...root.querySelectorAll<HTMLElement>('[role="tab"]')]
      expect(tabs().map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1])

      key(tabs()[0]!, 'ArrowRight')
      await nextTick()
      expect(active.value).toBe('b')
      expect(document.activeElement).toBe(tabs()[1])
      key(tabs()[1]!, 'ArrowRight')
      await nextTick()
      expect(active.value).toBe('d')
      key(tabs()[3]!, 'ArrowRight')
      await nextTick()
      expect(active.value).toBe('a')
      key(tabs()[0]!, 'ArrowLeft')
      await nextTick()
      expect(active.value).toBe('d')
      key(tabs()[3]!, 'Home')
      await nextTick()
      expect(active.value).toBe('a')
      key(tabs()[0]!, 'End')
      await nextTick()
      expect(active.value).toBe('d')
      expect(tabs()[3]!.getAttribute('aria-selected')).toBe('true')
    },
  )

  it('editor tabs can be closed', () => {
    const onClose = vi.fn()
    const root = mount(() =>
      h(Tabs, {
        variant: 'editor',
        tabs: [{ id: 'pkg', label: 'package.json', closable: true }],
        modelValue: 'pkg',
        onClose,
      }),
    )
    const close = root.querySelector<HTMLButtonElement>('.tab-close')!
    expect(close.getAttribute('aria-label')).toBe('关闭 package.json')
    close.click()
    expect(onClose).toHaveBeenCalledWith('pkg')
  })

  it('a tab may carry a hover title, kept on a disabled tab too (UI-S06)', () => {
    const root = mount(() =>
      h(Tabs, {
        variant: 'segmented',
        tabs: [
          {
            id: 'a',
            label: '审查',
            disabled: true,
            title: '当前会话未绑定项目',
          },
          { id: 'b', label: '文件' },
        ],
        modelValue: 'b',
      }),
    )
    const items = [...root.querySelectorAll<HTMLElement>('.tab-item')]
    // On the wrapper: a disabled button gets no pointer events.
    expect(items[0]!.getAttribute('title')).toBe('当前会话未绑定项目')
    expect(items[1]!.hasAttribute('title')).toBe(false)
  })

  it('Segmented is the segmented Tabs as a radio group', async () => {
    const value = ref<number>(7)
    const root = mount(() =>
      h(Segmented, {
        options: [
          { value: 7, label: '7 天' },
          { value: 30, label: '30 天' },
        ],
        modelValue: value.value,
        'onUpdate:modelValue': (next: number) => (value.value = next),
        ariaLabel: '范围',
      }),
    )
    const group = root.querySelector<HTMLElement>('.ds-tabs')!
    expect(group.dataset.variant).toBe('segmented')
    expect(group.getAttribute('role')).toBe('radiogroup')
    const radios = [...root.querySelectorAll<HTMLElement>('[role="radio"]')]
    expect(radios[0]!.getAttribute('aria-checked')).toBe('true')
    key(radios[0]!, 'ArrowRight')
    await nextTick()
    expect(value.value).toBe(30)
  })
})

// ── Test 8: Checkbox three states ─────────────────────────────────────────

describe('Checkbox (test 8)', () => {
  it('shows unchecked, checked and indeterminate, and a click settles the mixed state', async () => {
    const checked = ref(false)
    const mixed = ref(true)
    const root = mount(() =>
      h(
        Checkbox,
        {
          modelValue: checked.value,
          'onUpdate:modelValue': (value: boolean) => (checked.value = value),
          indeterminate: mixed.value,
          'onUpdate:indeterminate': (value: boolean) => (mixed.value = value),
        },
        () => '全选',
      ),
    )
    const box = root.querySelector<HTMLElement>('.ds-checkbox')!
    const input = box.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(box.dataset.state).toBe('mixed')
    expect(input.indeterminate).toBe(true)
    expect(box.textContent).toContain('全选')

    input.click()
    await nextTick()
    expect(checked.value).toBe(true)
    expect(mixed.value).toBe(false)
    expect(box.dataset.state).toBe('checked')
    expect(input.indeterminate).toBe(false)

    input.click()
    await nextTick()
    expect(checked.value).toBe(false)
    expect(box.dataset.state).toBe('unchecked')
  })

  it('a disabled checkbox does not change', async () => {
    const onUpdate = vi.fn()
    const root = mount(() =>
      h(Checkbox, {
        modelValue: false,
        disabled: true,
        'onUpdate:modelValue': onUpdate,
        ariaLabel: '允许',
      }),
    )
    const input = root.querySelector<HTMLInputElement>('input')!
    expect(input.getAttribute('aria-label')).toBe('允许')
    input.click()
    await nextTick()
    expect(onUpdate).not.toHaveBeenCalled()
  })
})

// ── Test 9: SearchField clear button and Escape ──────────────────────────

describe('SearchField (test 9)', () => {
  it('clears from its button and from Escape, then lets Escape through when empty', async () => {
    const query = ref('')
    const onClear = vi.fn()
    const outer = vi.fn()
    const root = mount(() =>
      h('div', { onKeydown: outer }, [
        h(SearchField, {
          modelValue: query.value,
          'onUpdate:modelValue': (value: string) => (query.value = value),
          onClear,
          placeholder: '搜索对话',
        }),
      ]),
    )
    const input = root.querySelector<HTMLInputElement>('input')!
    expect(input.getAttribute('aria-label')).toBe('搜索对话')
    expect(root.querySelector('.clear')).toBeNull()

    input.value = 'emperor'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    expect(query.value).toBe('emperor')
    const clear = root.querySelector<HTMLButtonElement>('.clear')!
    expect(clear.getAttribute('aria-label')).toBe('清除搜索')
    clear.click()
    await nextTick()
    expect(query.value).toBe('')
    expect(onClear).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(input)

    query.value = 'agent'
    await nextTick()
    const esc = key(input, 'Escape')
    await nextTick()
    expect(query.value).toBe('')
    expect(esc.defaultPrevented).toBe(true)
    expect(outer).not.toHaveBeenCalled()
    expect(onClear).toHaveBeenCalledTimes(2)

    // Empty: Escape belongs to whoever owns the search (closes a popover).
    key(input, 'Escape')
    expect(outer).toHaveBeenCalledTimes(1)
  })

  it('passes listeners and attributes to the input, class to the box', () => {
    const onKeydown = vi.fn()
    const root = mount(() =>
      h(SearchField, {
        modelValue: 'x',
        class: 'outer-box',
        'data-probe': 'yes',
        onKeydown,
      }),
    )
    const input = root.querySelector<HTMLInputElement>('input')!
    expect(root.querySelector('.ds-search-field')!.classList).toContain(
      'outer-box',
    )
    expect(input.dataset.probe).toBe('yes')
    key(input, 'ArrowDown')
    expect(onKeydown).toHaveBeenCalledOnce()
  })
})

// ── Test 10: PaneHeader is always 48px ────────────────────────────────────

describe('PaneHeader (test 10)', () => {
  it('holds title, optional tabs and actions in a fixed 48px bar', async () => {
    const root = mount(() =>
      h('div', [
        h(PaneHeader, { title: '工作台' }),
        h(
          PaneHeader,
          { title: '一个很长很长很长很长很长很长很长很长很长很长的标题' },
          {
            tabs: () =>
              h(Tabs, {
                tabs: [{ id: 'a', label: '文件' }],
                modelValue: 'a',
              }),
            actions: () => h('button', { class: 'act' }, '刷新'),
          },
        ),
      ]),
    )
    const headers = [...root.querySelectorAll<HTMLElement>('.ds-pane-header')]
    expect(headers).toHaveLength(2)
    expect(headers[0]!.querySelector('.title')?.textContent).toBe('工作台')
    expect(headers[1]!.querySelector('.tabs .ds-tabs')).not.toBeNull()
    expect(headers[1]!.querySelector('.actions .act')).not.toBeNull()
    for (const header of headers)
      expect(header.getAttribute('style')).toBeNull()

    const css = await source('PaneHeader')
    const rule = /\.ds-pane-header\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(rule).toMatch(/height:\s*var\(--pane-header-h\)/)
    expect(rule).toMatch(/min-height:\s*var\(--pane-header-h\)/)
    expect(rule).toMatch(/max-height:\s*var\(--pane-header-h\)/)
    expect(rule).toMatch(/flex:\s*none/)
    const tokens = readFileSync(
      join(__dirname, '../../theme/components.css'),
      'utf-8',
    )
    expect(tokens).toMatch(/--pane-header-h:\s*48px/)
  })
})
