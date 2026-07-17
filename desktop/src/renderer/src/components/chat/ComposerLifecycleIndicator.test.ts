// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createApp, h } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ComposerLifecycleIndicator from './ComposerLifecycleIndicator.vue'

const source = readFileSync(
  join(__dirname, 'ComposerLifecycleIndicator.vue'),
  'utf8',
)

let container: HTMLDivElement | null = null

afterEach(() => {
  container?.remove()
  container = null
})

describe('ComposerLifecycleIndicator', () => {
  it('emits dismiss for an idle lifecycle', async () => {
    const onDismiss = vi.fn()
    container = document.createElement('div')
    document.body.append(container)
    createApp(() =>
      h(ComposerLifecycleIndicator, {
        kind: 'goal',
        busy: false,
        onDismiss,
      }),
    ).mount(container)

    const button = container.querySelector<HTMLButtonElement>(
      '[aria-label="取消 Goal"]',
    )!
    expect(button.getAttribute('aria-disabled')).toBe('false')
    button.click()
    await Promise.resolve()

    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('keeps the close control focusable but inert while the Agent runs', async () => {
    const onDismiss = vi.fn()
    container = document.createElement('div')
    document.body.append(container)
    createApp(() =>
      h(ComposerLifecycleIndicator, {
        kind: 'plan',
        busy: true,
        onDismiss,
      }),
    ).mount(container)

    const button = container.querySelector<HTMLButtonElement>(
      '[aria-label="退出 Plan"]',
    )!
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.title).toContain('请先停止或暂停')
    button.focus()
    button.click()
    await Promise.resolve()

    expect(document.activeElement).toBe(button)
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('reveals a busy close control only on hover or keyboard focus', () => {
    expect(source).not.toMatch(
      /\n\.composer-lifecycle-dismiss\[aria-disabled='true'\]\s*\{[^}]*opacity:/s,
    )
    expect(source).toMatch(
      /:hover\s+\.composer-lifecycle-dismiss\[aria-disabled='true'\][^{]*\{[^}]*opacity:/s,
    )
    expect(source).toMatch(
      /:focus-within\s+\.composer-lifecycle-dismiss\[aria-disabled='true'\][^{]*\{[^}]*opacity:/s,
    )
  })
})
