// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useMarkdown } from './useMarkdown'
import {
  forgetRemoteImages,
  handleMarkdownClick,
  markdownLinkAction,
} from './useMarkdownLinks'

let root: HTMLDivElement | null = null

afterEach(() => {
  root?.remove()
  root = null
  forgetRemoteImages()
  delete (window as { emperor?: unknown }).emperor
})

function mount(markdown: string): HTMLDivElement {
  root = document.createElement('div')
  root.innerHTML = useMarkdown(ref(markdown)).rendered.value
  document.body.appendChild(root)
  return root
}

function click(target: Element | null, notify = vi.fn()) {
  expect(target).toBeTruthy()
  const event = new MouseEvent('click', { bubbles: true, cancelable: true })
  root!.addEventListener(
    'click',
    (e) => handleMarkdownClick(e, 'message-1', { notify }),
    { once: true },
  )
  target!.dispatchEvent(event)
  return { event, notify }
}

function anchor(href: string): HTMLAnchorElement {
  const a = document.createElement('a')
  a.setAttribute('href', href)
  return a
}

describe('markdown link actions (UI-4)', () => {
  it('sorts every href into one action', () => {
    expect(markdownLinkAction(anchor('packages/core'))).toEqual({
      kind: 'reference',
      href: 'packages/core',
    })
    expect(markdownLinkAction(anchor('/etc/hosts')).kind).toBe('reference')
    expect(markdownLinkAction(anchor('https://example.com/a'))).toEqual({
      kind: 'web',
      url: 'https://example.com/a',
    })
    expect(markdownLinkAction(anchor('mailto:a@example.com'))).toEqual({
      kind: 'external',
      url: 'mailto:a@example.com',
    })
    expect(markdownLinkAction(anchor('tel:+8610123')).kind).toBe('external')
    expect(markdownLinkAction(anchor('#install')).kind).toBe('anchor')
    expect(markdownLinkAction(anchor('')).kind).toBe('anchor')
    expect(markdownLinkAction(anchor('sms:123'))).toEqual({
      kind: 'refused',
      scheme: 'sms:',
    })
    expect(markdownLinkAction(anchor('app://bundle/x')).kind).toBe('refused')
    const chip = anchor('https://example.com/b')
    chip.className = 'md-link-chip'
    expect(markdownLinkAction(chip).kind).toBe('reference')
  })

  it('never lets a relative link navigate: it goes to the reference resolver', () => {
    const listener = vi.fn()
    window.addEventListener('emperor:resolve-reference', listener)
    const view = mount('看 [packages/core](packages/core)')
    const link = view.querySelector('a')!
    expect(link.classList.contains('md-link-chip')).toBe(false)
    const { event } = click(link)
    expect(event.defaultPrevented).toBe(true)
    expect((listener.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      href: 'packages/core',
      label: 'packages/core',
      sourceMessageId: 'message-1',
    })
    window.removeEventListener('emperor:resolve-reference', listener)
  })

  it('hands mailto: and tel: to the system (shell.openExternal)', async () => {
    const openExternal = vi.fn(async () => ({ ok: true }))
    ;(window as { emperor?: unknown }).emperor = { openExternal }
    const view = mount(
      '[写信](mailto:someone@example.com) [电话](tel:+861012345)',
    )
    const links = view.querySelectorAll('a')
    expect(click(links[0]!).event.defaultPrevented).toBe(true)
    expect(click(links[1]!).event.defaultPrevented).toBe(true)
    await Promise.resolve()
    expect(openExternal.mock.calls).toEqual([
      ['mailto:someone@example.com'],
      ['tel:+861012345'],
    ])
  })

  it('ignores other schemes and says so', () => {
    const view = mount('[短信](sms:10086)')
    const { event, notify } = click(view.querySelector('a'))
    expect(event.defaultPrevented).toBe(true)
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('sms:'))
  })

  it('swallows in-page anchors without navigating', () => {
    root = document.createElement('div')
    root.innerHTML = '<a href="#install">安装</a>'
    document.body.appendChild(root)
    const { event, notify } = click(root.querySelector('a'))
    expect(event.defaultPrevented).toBe(true)
    expect(notify).not.toHaveBeenCalled()
  })
})

describe('remote markdown images (UI-38)', () => {
  it('loads nothing until clicked, then shows the image main fetched', async () => {
    const loadRemoteImage = vi.fn(async () => ({
      ok: true,
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    }))
    ;(window as { emperor?: unknown }).emperor = { loadRemoteImage }
    const view = mount('![架构图](https://example.com/arch.png)')
    expect(view.querySelector('img')).toBeNull()
    expect(loadRemoteImage).not.toHaveBeenCalled()

    const placeholder = view.querySelector('[data-md-remote-image]')
    const { event } = click(placeholder)
    expect(event.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(view.querySelector('img')).not.toBeNull())
    expect(loadRemoteImage).toHaveBeenCalledWith('https://example.com/arch.png')
    const image = view.querySelector('img')!
    expect(image.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(image.alt).toBe('架构图')
    expect(view.querySelector('[data-md-remote-image]')).toBeNull()
  })

  it('keeps the placeholder with the reason when main refuses', async () => {
    const loadRemoteImage = vi.fn(async () => ({
      ok: false,
      error: '这个地址不能加载',
    }))
    ;(window as { emperor?: unknown }).emperor = { loadRemoteImage }
    const view = mount('![x](http://192.168.1.1/admin.png)')
    click(view.querySelector('[data-md-remote-image]'))
    await vi.waitFor(() =>
      expect(view.textContent).toContain('这个地址不能加载'),
    )
    expect(view.querySelector('img')).toBeNull()
    expect(view.querySelector('[data-md-remote-image]')).not.toBeNull()
  })
})
