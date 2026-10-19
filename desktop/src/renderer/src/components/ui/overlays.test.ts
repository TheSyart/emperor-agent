// @vitest-environment jsdom
// DS-05 (PLAN-V020): overlays — Modal focus handling, ConfirmDialog, the
// toast queue and Popover.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ConfirmHost from './ConfirmHost.vue'
import Modal from './Modal.vue'
import Popover from './Popover.vue'
import ToastStack from './ToastStack.vue'
import { answerConfirmsForTest, confirm, pendingConfirmCount } from './confirm'
import {
  TOAST_DURATION_MS,
  TOAST_VISIBLE,
  dismissToast,
  pushToast,
  queuedToastCount,
  resetToastsForTest,
  showErrorToast,
  visibleToasts,
} from './toasts'

const apps: App[] = []

function mount(render: () => ReturnType<typeof h>): HTMLElement {
  const host = document.createElement('div')
  host.id = 'app'
  document.body.append(host)
  const app = createApp(render)
  app.config.warnHandler = () => undefined
  app.mount(host)
  apps.push(app)
  return host
}

function key(name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: name,
    bubbles: true,
    cancelable: true,
    ...init,
  })
  ;(document.activeElement ?? document.body).dispatchEvent(event)
  return event
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await nextTick()
    await Promise.resolve()
  }
}

afterEach(() => {
  while (apps.length) apps.pop()?.unmount()
  document.body.innerHTML = ''
  answerConfirmsForTest(null)
  resetToastsForTest()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** A trigger button that opens a Modal with two fields and a footer action. */
function mountDialog(opts: { nested?: boolean } = {}) {
  const open = ref(false)
  const inner = ref(false)
  const host = mount(() =>
    h('div', [
      h(
        'button',
        { id: 'trigger', onClick: () => (open.value = true) },
        'Open',
      ),
      h('button', { id: 'behind' }, 'Behind'),
      h(
        Modal,
        {
          open: open.value,
          'onUpdate:open': (value: boolean) => (open.value = value),
          title: 'Rename',
        },
        {
          default: () => [
            h('input', { id: 'first', 'aria-label': 'Name' }),
            h('input', { id: 'second', 'aria-label': 'Note' }),
            opts.nested
              ? h(
                  Modal,
                  {
                    open: inner.value,
                    'onUpdate:open': (value: boolean) => (inner.value = value),
                    title: 'Inner',
                  },
                  { default: () => h('input', { id: 'inner-field' }) },
                )
              : null,
          ],
          footer: () =>
            h(
              'button',
              { id: 'save', onClick: () => (inner.value = true) },
              'Save',
            ),
        },
      ),
    ]),
  )
  return { host, open, inner }
}

async function openFromTrigger(open: { value: boolean }) {
  const trigger = document.getElementById('trigger') as HTMLButtonElement
  trigger.focus()
  open.value = true
  await settle()
  return trigger
}

describe('Modal focus', () => {
  it('moves focus into the dialog, to its first control (1)', async () => {
    const { open } = mountDialog()
    await openFromTrigger(open)
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(document.activeElement?.id).toBe('first')
  })

  it('keeps Tab and Shift+Tab inside the dialog (2)', async () => {
    const { open } = mountDialog()
    await openFromTrigger(open)
    document.getElementById('save')!.focus()
    expect(key('Tab').defaultPrevented).toBe(true)
    // Wraps to the first control in the dialog (the close button comes last).
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.contains(document.activeElement)).toBe(true)
    const wrapped = document.activeElement
    key('Tab', { shiftKey: true })
    expect(document.activeElement).not.toBe(wrapped)
    expect(dialog.contains(document.activeElement)).toBe(true)
    // Focus that escaped (a click on the page behind) is pulled back in.
    ;(document.activeElement as HTMLElement).blur()
    key('Tab')
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it('returns focus to the trigger when it closes (3)', async () => {
    const { open } = mountDialog()
    const trigger = await openFromTrigger(open)
    key('Escape')
    await settle()
    expect(open.value).toBe(false)
    expect(document.activeElement).toBe(trigger)
  })

  it('makes the page behind inert while open, and restores it (4)', async () => {
    const { host, open } = mountDialog()
    await openFromTrigger(open)
    expect(host.hasAttribute('inert')).toBe(true)
    const overlay = document.querySelector<HTMLElement>('.ds-modal')!
    expect(overlay.hasAttribute('inert')).toBe(false)
    // The dialog's own mask stays clickable (mask click closes).
    expect(overlay.querySelector('.mask')!.hasAttribute('inert')).toBe(false)
    open.value = false
    await settle()
    expect(host.hasAttribute('inert')).toBe(false)
  })

  it('closes only the top dialog on Escape when two are stacked (5)', async () => {
    const { open, inner } = mountDialog({ nested: true })
    await openFromTrigger(open)
    const save = document.getElementById('save') as HTMLButtonElement
    save.focus()
    save.click()
    await settle()
    expect(inner.value).toBe(true)
    expect(document.activeElement?.id).toBe('inner-field')
    // The outer dialog is inert under the inner one.
    const [outer] = document.querySelectorAll<HTMLElement>('.ds-modal')
    expect(outer!.hasAttribute('inert')).toBe(true)
    key('Escape')
    await settle()
    expect(inner.value).toBe(false)
    expect(open.value).toBe(true)
    expect(outer!.hasAttribute('inert')).toBe(false)
    expect(document.activeElement).toBe(save)
  })

  it('uses one close button, an IconButton labelled 关闭', async () => {
    const { open } = mountDialog()
    await openFromTrigger(open)
    const close = document.querySelector('.ds-modal .ds-icon-button')!
    expect(close.getAttribute('aria-label')).toBe('关闭')
    expect(close.getAttribute('data-size')).toBe('sm')
    expect(close.getAttribute('data-shape')).toBe('square')
  })
})

describe('confirm()', () => {
  beforeEach(() => {
    mount(() => h(ConfirmHost))
  })

  it('resolves false on 取消 and true on the confirm button (6)', async () => {
    const first = confirm({ title: '删除凭据？', body: '删除后无法恢复。' })
    await settle()
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('删除凭据？')
    expect(dialog.textContent).toContain('删除后无法恢复。')
    const cancel = [...dialog.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === '取消',
    )!
    cancel.click()
    await expect(first).resolves.toBe(false)

    const second = confirm({
      title: '丢弃修改？',
      confirmLabel: '丢弃',
      tone: 'danger',
    })
    await settle()
    const button = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
    ].find((b) => b.textContent?.trim() === '丢弃')!
    expect(button.getAttribute('data-variant')).toBe('danger')
    button.click()
    await expect(second).resolves.toBe(true)
    expect(pendingConfirmCount()).toBe(0)
  })

  it('resolves false on Escape, focuses 取消 for danger and queues requests', async () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    const a = confirm({ title: 'A', tone: 'danger' })
    const b = confirm({ title: 'B' })
    await settle()
    expect(document.activeElement?.textContent?.trim()).toBe('取消')
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    key('Escape')
    await expect(a).resolves.toBe(false)
    await settle()
    // The default tone focuses the confirm button.
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'B',
    )
    expect(document.activeElement?.textContent?.trim()).toBe('确定')
    ;(document.activeElement as HTMLButtonElement).click()
    await expect(b).resolves.toBe(true)
    await settle()
    expect(document.activeElement).toBe(trigger)
  })

  it('can be answered without a host in tests', async () => {
    const responder = vi.fn(() => false)
    answerConfirmsForTest(responder)
    await expect(confirm({ title: 'X' })).resolves.toBe(false)
    expect(responder).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'X' }),
    )
  })
})

describe('no native dialogs (7)', () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) return sources(path)
      return /\.(vue|ts)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : []
    })
  }

  it('never calls window.confirm, alert or prompt in the renderer', () => {
    const root = join(__dirname, '../..')
    const offenders = sources(root).filter((path) =>
      /\bwindow\.(confirm|alert|prompt)\s*\(|(?<![\w.$])(alert|prompt)\(/.test(
        readFileSync(path, 'utf8'),
      ),
    )
    expect(offenders.map((path) => relative(root, path))).toEqual([])
  })
})

describe('toast queue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it(`shows ${TOAST_VISIBLE} toasts at once and queues the fourth (8)`, async () => {
    mount(() => h(ToastStack))
    for (const message of ['一', '二', '三', '四']) pushToast(message)
    await settle()
    const shown = () =>
      [...document.querySelectorAll('.ds-toast .text')].map(
        (el) => el.textContent,
      )
    expect(shown()).toEqual(['一', '二', '三'])
    expect(queuedToastCount.value).toBe(1)
    // The fourth starts its own 4 s only once it is on screen.
    vi.advanceTimersByTime(TOAST_DURATION_MS)
    await settle()
    expect(shown()).toEqual(['四'])
    vi.advanceTimersByTime(TOAST_DURATION_MS - 1)
    await settle()
    expect(shown()).toEqual(['四'])
    vi.advanceTimersByTime(1)
    await settle()
    expect(shown()).toEqual([])
  })

  it('folds a repeat of a visible toast into it instead of stacking', () => {
    pushToast('已复制')
    vi.advanceTimersByTime(3000)
    pushToast('已复制')
    expect(visibleToasts.value).toHaveLength(1)
    vi.advanceTimersByTime(3000)
    expect(visibleToasts.value).toHaveLength(1)
    vi.advanceTimersByTime(1000)
    expect(visibleToasts.value).toHaveLength(0)
  })

  it('keeps an error toast until closed and copies its details (9)', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    mount(() => h(ToastStack))
    const error = Object.assign(new Error('磁盘已满'), {
      errorId: 'ipc_0123456789ab',
    })
    showErrorToast(error, '保存记忆失败')
    await settle()
    vi.advanceTimersByTime(TOAST_DURATION_MS * 10)
    await settle()
    const toast = document.querySelector<HTMLElement>(
      '.ds-toast[data-tone="error"]',
    )!
    expect(toast.textContent).toContain('保存记忆失败：磁盘已满')
    expect(toast.getAttribute('role')).toBe('alert')
    const copy = [...toast.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === '复制详情',
    )!
    copy.click()
    await settle()
    expect(writeText).toHaveBeenCalledOnce()
    const copied = String((writeText.mock.calls[0] as unknown as [string])[0])
    expect(copied).toContain('ipc_0123456789ab')
    expect(copied).toContain('磁盘已满')
    const close = toast.querySelector<HTMLButtonElement>(
      'button[aria-label="关闭"]',
    )!
    close.click()
    await settle()
    expect(document.querySelector('.ds-toast')).toBeNull()
  })

  it('gives an error without an id one of its own', () => {
    const id = showErrorToast('出错了')
    const toast = visibleToasts.value.find((item) => item.id === id)!
    expect(toast.errorId).toMatch(/^ui_[0-9a-z]+$/)
    expect(toast.sticky).toBe(true)
    dismissToast(id)
    expect(visibleToasts.value).toHaveLength(0)
  })

  it('ignores an empty message', () => {
    pushToast('')
    expect(visibleToasts.value).toHaveLength(0)
  })

  it('stays clickable above an open modal', async () => {
    const open = ref(true)
    mount(() =>
      h('div', [
        h(ToastStack),
        h(Modal, { open: open.value, title: 'M' }, () => h('input')),
      ]),
    )
    showErrorToast('x')
    await settle()
    const stack = document.querySelector<HTMLElement>('.ds-toast-stack')!
    expect(stack.closest('[inert]')).toBeNull()
  })
})

describe('Popover', () => {
  function mountPopover() {
    const open = ref(false)
    const anchor = ref<HTMLElement | null>(null)
    mount(() =>
      h('div', [
        h(
          'button',
          {
            id: 'anchor',
            ref: (el) => (anchor.value = el as HTMLElement | null),
            onClick: () => (open.value = !open.value),
          },
          'Usage',
        ),
        h('button', { id: 'outside' }, 'Outside'),
        h(
          Popover,
          {
            open: open.value,
            'onUpdate:open': (value: boolean) => (open.value = value),
            anchor: anchor.value,
            label: '上下文用量',
          },
          () => h('button', { id: 'inside' }, 'Inside'),
        ),
      ]),
    )
    return open
  }

  it('opens next to its anchor as a labelled dialog', async () => {
    const open = mountPopover()
    open.value = true
    await settle()
    const panel = document.querySelector<HTMLElement>('.ds-popover')!
    expect(panel.getAttribute('role')).toBe('dialog')
    expect(panel.getAttribute('aria-label')).toBe('上下文用量')
    expect(panel.style.left).not.toBe('')
  })

  it('closes on an outside press but not on a press inside', async () => {
    const open = mountPopover()
    open.value = true
    await settle()
    document
      .getElementById('inside')!
      .dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    await settle()
    expect(open.value).toBe(true)
    document
      .getElementById('outside')!
      .dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    await settle()
    expect(open.value).toBe(false)
  })

  it('closes on Escape and gives focus back to the anchor', async () => {
    const open = mountPopover()
    const anchor = document.getElementById('anchor') as HTMLButtonElement
    anchor.focus()
    open.value = true
    await settle()
    document.getElementById('inside')!.focus()
    key('Escape')
    await settle()
    expect(open.value).toBe(false)
    expect(document.activeElement).toBe(anchor)
  })
})

describe('first-run dialog', () => {
  it('joins the modal stack: focus on 配置模型, app inert, Escape closes', async () => {
    const { default: ModelSetupRequiredDialog } =
      await import('../onboarding/ModelSetupRequiredDialog.vue')
    const onClose = vi.fn()
    const host = mount(() =>
      h('div', { class: 'shell' }, [
        h('button', { id: 'behind' }, 'Behind'),
        h(ModelSetupRequiredDialog, {
          open: true,
          message: '',
          onClose,
          onConfigure: () => undefined,
        }),
      ]),
    )
    await settle()
    expect(document.activeElement?.hasAttribute('data-autofocus')).toBe(true)
    expect(host.querySelector('#behind')!.hasAttribute('inert')).toBe(true)
    key('Escape')
    expect(onClose).toHaveBeenCalledOnce()
  })
})
