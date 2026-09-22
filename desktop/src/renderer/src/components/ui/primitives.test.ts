// @vitest-environment jsdom
import { createApp, h, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import DisclosureRow from './DisclosureRow.vue'
import StateDot from './StateDot.vue'
import DiffBlock from './DiffBlock.vue'
import Tabs from './Tabs.vue'
import { stateDotClasses, stateFromStatus, chaseDelayMs } from './stateDot'
import { formatElapsed } from './elapsed'
import { headTailCap, capRows } from './headTailCap'
import { parseAnsiLines, ansiClasses } from './ansi'
import { promptLabel, terminalStatus } from './terminal'
import { jsonPreview, jsonKind } from './jsonTree'
import * as DsIcons from '../icons/ds'

let container: HTMLDivElement | null = null
let app: ReturnType<typeof createApp> | null = null

function mount(render: () => ReturnType<typeof h>) {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp(render)
  app.mount(container)
  return container
}

afterEach(() => {
  app?.unmount()
  container?.remove()
  container = null
  app = null
})

describe('DisclosureRow', () => {
  it('toggles its body from the row and reports v-model:open', async () => {
    const open = ref(false)
    const root = mount(() =>
      h(
        DisclosureRow,
        {
          title: 'Read',
          summary: 'theme/dark.css',
          open: open.value,
          'onUpdate:open': (value: boolean) => (open.value = value),
        },
        { default: () => h('p', { class: 'body-probe' }, 'payload') },
      ),
    )
    const row = root.querySelector<HTMLElement>('[data-disclosure-row]')!
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(root.querySelector('.body-probe')).toBeNull()
    expect(root.querySelector('.summary')?.textContent).toBe('theme/dark.css')

    row.click()
    await nextTick()
    expect(open.value).toBe(true)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(root.querySelector('.body-probe')?.textContent).toBe('payload')

    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await nextTick()
    expect(open.value).toBe(false)
    expect(root.querySelector('.body-probe')).toBeNull()
  })

  it('does not toggle when not expandable and marks running rows', async () => {
    const root = mount(() =>
      h(DisclosureRow, { title: 'Bash', expandable: false, running: true }),
    )
    const row = root.querySelector<HTMLElement>('[data-disclosure-row]')!
    expect(row.hasAttribute('data-running')).toBe(true)
    expect(row.classList.contains('ds-glare')).toBe(true)
    expect(row.getAttribute('role')).toBeNull()
    row.click()
    await nextTick()
    expect(root.querySelector('[data-open]')).toBeNull()
  })
})

describe('StateDot', () => {
  it('maps states to classes and renders the ongoing chase', () => {
    expect(stateDotClasses('ok')).toEqual(['ds-state-dot', 'ds-state-dot--ok'])
    expect(stateDotClasses('error')).toContain('ds-state-dot--error')
    expect(chaseDelayMs(0)).toBe(-1000)
    expect(stateFromStatus('running')).toBe('ongoing')
    expect(stateFromStatus('failed')).toBe('error')
    expect(stateFromStatus('interrupted')).toBe('warn')
    expect(stateFromStatus(undefined)).toBe('ok')

    const root = mount(() =>
      h('div', [
        h(StateDot, { state: 'warn' }),
        h(StateDot, { state: 'ongoing', size: 12 }),
      ]),
    )
    const solid = root.querySelector('span.ds-state-dot')!
    expect(solid.classList.contains('ds-state-dot--warn')).toBe(true)
    expect(solid.getAttribute('aria-hidden')).toBe('true')
    const chase = root.querySelector('svg.ds-state-dot--ongoing')!
    expect(chase.getAttribute('width')).toBe('12')
    expect(chase.querySelectorAll('rect.ds-chase-cell')).toHaveLength(8)
  })
})

describe('DiffBlock', () => {
  it('renders +/- rows, context and the footer', () => {
    const root = mount(() =>
      h(DiffBlock, {
        diffs: [
          {
            path: 'src/a.ts',
            oldText: 'one\ntwo\nthree\n',
            newText: 'one\nTWO\nthree\n',
          },
          { path: 'src/b.ts', oldText: null, newText: 'fresh\n' },
        ],
      }),
    )
    const rows = [...root.querySelectorAll('.line')].map(
      (el) =>
        `${[...el.classList].find((c) => c.startsWith('line--'))}:${el.textContent}`,
    )
    expect(rows).toEqual([
      'line--path:src/a.ts',
      'line--ctx:one',
      'line--del:two',
      'line--add:TWO',
      'line--ctx:three',
      'line--path:src/b.ts',
      'line--add:fresh',
    ])
    expect(root.querySelector('.footer')?.textContent).toBe('└ +2 -1 · 2 files')
  })

  it('caps long diffs to head/tail with an expand control', async () => {
    const newText = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    const root = mount(() =>
      h(DiffBlock, {
        diffs: [{ path: 'x', oldText: null, newText }],
        maxLines: 6,
      }),
    )
    expect(root.querySelectorAll('.line')).toHaveLength(6)
    const expand = root.querySelector<HTMLButtonElement>('.expand')!
    expect(expand.textContent?.trim()).toBe('… 其余 35 行')
    expand.click()
    await nextTick()
    expect(root.querySelectorAll('.line')).toHaveLength(41)
  })
})

describe('Tabs', () => {
  it('selects tabs and skips disabled ones', async () => {
    const active = ref('chat')
    const root = mount(() =>
      h(Tabs, {
        tabs: [
          { id: 'chat', label: 'Chat' },
          { id: 'off', label: 'Off', disabled: true },
          { id: 'trajectory', label: 'Trajectory' },
        ],
        modelValue: active.value,
        'onUpdate:modelValue': (value: string) => (active.value = value),
      }),
    )
    const tabs = root.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')
    tabs[0].dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    )
    await nextTick()
    expect(active.value).toBe('trajectory')
    tabs[1].click()
    expect(active.value).toBe('trajectory')
  })
})

describe('pure helpers', () => {
  it('formats elapsed time like the dsh turn clock', () => {
    expect(formatElapsed(9_400)).toBe('9s')
    expect(formatElapsed(65_000)).toBe('1m 05s')
    expect(formatElapsed(3_720_000)).toBe('1h 02m')
    expect(formatElapsed(-5)).toBe('0s')
  })

  it('splits head and tail around the cap', () => {
    const cap = headTailCap(20, 6, false)
    expect(cap).toEqual({
      hidden: 14,
      capped: true,
      headLines: 3,
      tailLines: 3,
    })
    const { head, tail } = capRows([...Array(20).keys()], cap)
    expect(head).toEqual([0, 1, 2])
    expect(tail).toEqual([17, 18, 19])
    expect(capRows([1, 2], headTailCap(2, 6, false)).tail).toEqual([])
  })

  it('parses ANSI SGR colors and drops other escapes', () => {
    const [line] = parseAnsiLines(
      '\u001b[1;31mFAIL\u001b[0m ok\u001b]0;title\u0007',
    )
    expect(line).toEqual([
      { text: 'FAIL', color: 'red', bold: true },
      { text: ' ok' },
    ])
    expect(ansiClasses(line[0])).toEqual(['ansi-red', 'ansi-bold'])
    expect(parseAnsiLines('50%\r100%')[0]).toEqual([{ text: '100%' }])
  })

  it('labels terminal prompts and exit status', () => {
    expect(promptLabel('/Users/me/project/', '/Users/me')).toBe('project')
    expect(promptLabel('/Users/me', '/Users/me/')).toBe('~')
    expect(terminalStatus(true, undefined, undefined).dot).toBe('ongoing')
    expect(terminalStatus(false, 2, undefined)).toMatchObject({
      dot: 'error',
      pill: '退出码 2',
    })
    expect(terminalStatus(false, 0, undefined).pill).toBeUndefined()
  })

  it('previews JSON nodes', () => {
    expect(jsonKind([])).toBe('array')
    expect(jsonKind(null)).toBe('null')
    expect(jsonPreview({ a: 1, b: 'x', c: { d: 1 } })).toBe(
      '{a: 1, b: "x", c: {…}}',
    )
    expect(jsonPreview([1, 2, 3])).toBe('Array(3)')
  })

  it('exports every ds icon listed in DS_ICON_NAMES', () => {
    for (const name of DsIcons.DS_ICON_NAMES)
      expect((DsIcons as Record<string, unknown>)[name]).toBeTruthy()
    expect(DsIcons.DS_ICON_NAMES.length).toBeGreaterThanOrEqual(40)
  })
})
