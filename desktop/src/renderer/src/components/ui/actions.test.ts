// @vitest-environment jsdom
// DS-03 (PLAN-V020): foundation and action components — Button, IconButton,
// LinkButton, Icon, Spinner, Skeleton, Kbd — and the rules they enforce.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createApp, h, nextTick, type Component } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Button from './Button.vue'
import Icon from './Icon.vue'
import IconButton from './IconButton.vue'
import Kbd from './Kbd.vue'
import LinkButton from './LinkButton.vue'
import Skeleton from './Skeleton.vue'
import Spinner from './Spinner.vue'
import { ICON_SIZES, iconNames } from './iconRegistry'

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

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  app?.unmount()
  container?.remove()
  container = null
  app = null
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('Button', () => {
  it('renders four variants in three sizes (32 is the default height)', () => {
    const root = mount(() =>
      h('div', [
        ...(['primary', 'secondary', 'ghost', 'danger'] as const).flatMap(
          (variant) =>
            (['sm', 'md', 'lg'] as const).map((size) =>
              h(Button, { variant, size }, () => `${variant}-${size}`),
            ),
        ),
        h(Button, null, () => 'default'),
      ]),
    )
    const buttons = [...root.querySelectorAll('button.ds-button')]
    expect(buttons).toHaveLength(13)
    expect(
      buttons.map(
        (b) =>
          `${b.getAttribute('data-variant')}:${b.getAttribute('data-size')}`,
      ),
    ).toMatchSnapshot()
    expect(buttons.at(-1)?.getAttribute('data-variant')).toBe('ghost')
    expect(buttons.at(-1)?.getAttribute('data-size')).toBe('md')
  })

  it('warns in development when a container holds a second primary button', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    mount(() =>
      h('div', [
        h(Button, { variant: 'primary' }, () => 'Save'),
        h(Button, { variant: 'primary' }, () => 'Also save'),
      ]),
    )
    await nextTick()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('more than one primary Button'),
    )
  })

  it('shows a spinner and refuses clicks while loading', async () => {
    const onClick = vi.fn()
    const root = mount(() =>
      h(Button, { variant: 'primary', loading: true, onClick }, () => 'Send'),
    )
    const button = root.querySelector('button')!
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(root.querySelector('.ds-spinner')).not.toBeNull()
    button.click()
    expect(onClick).not.toHaveBeenCalled()
  })

  it('activates from the keyboard like a native button (Enter and Space)', () => {
    const onClick = vi.fn()
    const root = mount(() => h(Button, { onClick }, () => 'Go'))
    const button = root.querySelector('button')!
    // A native <button> turns Enter/Space into click; the component must stay one.
    expect(button.tagName).toBe('BUTTON')
    expect(button.getAttribute('type')).toBe('button')
    button.click()
    expect(onClick).toHaveBeenCalledOnce()
  })
})

describe('IconButton', () => {
  it('reports a missing label in development', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mount(() => h(IconButton as Component, {}, () => 'x'))
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('IconButton needs a label'),
    )
  })

  it('shows its label in a Tooltip, not a native title', async () => {
    const root = mount(() =>
      h(IconButton, { label: '复制', shortcut: '⌘C' }, () => 'c'),
    )
    const button = root.querySelector('button')!
    expect(button.getAttribute('title')).toBeNull()
    expect(button.getAttribute('aria-label')).toBe('复制')
    button.dispatchEvent(new Event('pointerenter'))
    vi.advanceTimersByTime(500)
    await nextTick()
    const bubble = document.body.querySelector('[role="tooltip"]')
    expect(bubble?.textContent).toContain('复制')
    expect(bubble?.querySelector('kbd')?.textContent).toBe('⌘C')
  })

  it('has three sizes, three variants and two shapes', () => {
    const root = mount(() =>
      h('div', [
        h(IconButton, { label: 'a', size: 'xs' }),
        h(IconButton, { label: 'b', size: 'sm', variant: 'tonal' }),
        h(IconButton, {
          label: 'c',
          size: 'md',
          variant: 'primary',
          shape: 'circle',
        }),
      ]),
    )
    const [a, b, c] = [...root.querySelectorAll('button')]
    expect(a!.dataset).toMatchObject({
      size: 'xs',
      variant: 'ghost',
      shape: 'square',
    })
    expect(b!.dataset).toMatchObject({ size: 'sm', variant: 'tonal' })
    expect(c!.dataset).toMatchObject({
      size: 'md',
      variant: 'primary',
      shape: 'circle',
    })
  })

  it('opens its tooltip below when the window top leaves no room (UI-S01 top bars)', async () => {
    const root = mount(() => h(IconButton, { label: '工作台' }, () => 'w'))
    const button = root.querySelector('button')!
    const at = (top: number) =>
      vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
        x: 100,
        y: top,
        top,
        left: 100,
        right: 128,
        bottom: top + 28,
        width: 28,
        height: 28,
        toJSON: () => ({}),
      })
    at(17)
    button.dispatchEvent(new Event('pointerenter'))
    vi.advanceTimersByTime(500)
    await nextTick()
    let bubble = document.body.querySelector<HTMLElement>('[role="tooltip"]')!
    expect(bubble.dataset.side).toBe('bottom')
    expect(bubble.style.top).toBe(`${17 + 28 + 6}px`)
    button.dispatchEvent(new Event('pointerleave'))
    await nextTick()
    at(300)
    button.dispatchEvent(new Event('pointerenter'))
    vi.advanceTimersByTime(500)
    await nextTick()
    bubble = document.body.querySelector<HTMLElement>('[role="tooltip"]')!
    expect(bubble.dataset.side).toBe('top')
  })

  it('has the 36px rail size and a selected state on --surface-selected (UI-S01)', async () => {
    const root = mount(() =>
      h('div', [
        h(IconButton, { label: '会话', size: 'lg', selected: true }),
        h(IconButton, { label: '能力', size: 'lg' }),
      ]),
    )
    const [on, off] = [...root.querySelectorAll('button')]
    expect(on!.dataset).toMatchObject({ size: 'lg', selected: 'true' })
    expect(off!.hasAttribute('data-selected')).toBe(false)
    const source = (await import('./IconButton.vue?raw')).default
    expect(source).toMatch(
      /\[data-size='lg'\]\s*\{[^}]*width:\s*var\(--icon-button-lg\)[^}]*height:\s*var\(--icon-button-lg\)/,
    )
    expect(source).toMatch(
      /\[data-selected\][^{]*\{[^}]*background:\s*rgb\(var\(--surface-selected\)\)/,
    )
    const tokens = readFileSync(
      join(__dirname, '../../theme/components.css'),
      'utf8',
    )
    expect(tokens).toMatch(/--icon-button-lg:\s*36px;/)
  })
})

describe('focus ring', () => {
  it('draws focus with --focus-ring in both buttons', async () => {
    const button = await import('./Button.vue?raw')
    const iconButton = await import('./IconButton.vue?raw')
    for (const source of [button.default, iconButton.default])
      expect(source).toMatch(/:focus-visible[\s\S]*?var\(--focus-ring\)/)
  })
})

describe('Spinner', () => {
  function reducedMotion(matches: boolean) {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      })),
    )
  }

  it('spins normally', () => {
    reducedMotion(false)
    const root = mount(() => h(Spinner, { size: 'md' }))
    const spinner = root.querySelector('.ds-spinner')!
    expect(spinner.getAttribute('data-static')).toBeNull()
    expect(spinner.getAttribute('role')).toBe('status')
  })

  it('stays still when the user asks for reduced motion', () => {
    reducedMotion(true)
    const root = mount(() => h(Spinner, { size: 'sm', tone: 'accent' }))
    const spinner = root.querySelector('.ds-spinner')!
    expect(spinner.getAttribute('data-static')).toBe('')
    expect(spinner.getAttribute('data-tone')).toBe('accent')
  })
})

describe('Icon', () => {
  it('renders a registered icon at a token size with a 1.5 stroke', () => {
    const root = mount(() => h(Icon, { name: 'search', size: 'lg' }))
    const svg = root.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('20')
    expect(iconNames()).toContain('arrow-up')
    expect(iconNames()).toContain('search')
  })

  it.each([13, 15, 18, 22])('refuses the off-scale size %i', (size) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const root = mount(() => h(Icon as Component, { name: 'search', size }))
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Icon size'))
    // Falls back to md (16) instead of drawing the off-scale size.
    expect(root.querySelector('svg')?.getAttribute('width')).toBe('16')
  })

  it('maps the four token sizes', () => {
    expect(ICON_SIZES).toEqual({ xs: 12, sm: 14, md: 16, lg: 20 })
  })
})

describe('small helpers', () => {
  it('Kbd renders a key label', () => {
    const root = mount(() => h(Kbd, null, () => '⌘K'))
    expect(root.querySelector('kbd.ds-kbd')?.textContent).toBe('⌘K')
  })

  it('LinkButton is a text button in the link colour', async () => {
    const onClick = vi.fn()
    const root = mount(() => h(LinkButton, { onClick }, () => '查看详情'))
    const link = root.querySelector<HTMLButtonElement>('button.ds-link-button')!
    link.click()
    expect(onClick).toHaveBeenCalledOnce()
    const source = await import('./LinkButton.vue?raw')
    expect(source.default).toContain('var(--text-link)')
  })

  it('Skeleton draws a line, a block or a circle', () => {
    const root = mount(() =>
      h('div', [
        h(Skeleton, { shape: 'line' }),
        h(Skeleton, { shape: 'block', height: '40px' }),
        h(Skeleton, { shape: 'circle' }),
      ]),
    )
    expect(
      [...root.querySelectorAll('.ds-skeleton')].map((el) =>
        el.getAttribute('data-shape'),
      ),
    ).toEqual(['line', 'block', 'circle'])
  })
})
