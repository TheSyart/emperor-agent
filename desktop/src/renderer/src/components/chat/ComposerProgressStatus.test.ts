// @vitest-environment jsdom
import { createApp, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TurnChangeSnapshot } from '../../types'
import ComposerProgressStatus from './ComposerProgressStatus.vue'

let container: HTMLDivElement | null = null

afterEach(() => {
  container?.remove()
  container = null
})

const progress = {
  source: 'plan' as const,
  currentStep: 2,
  totalSteps: 3,
  items: [
    { id: 'step-1', label: '调研', status: 'completed' as const },
    { id: 'step-2', label: '实现', status: 'active' as const },
    { id: 'step-3', label: '验证', status: 'pending' as const },
  ],
}

const snapshot: TurnChangeSnapshot = {
  version: 2,
  sessionId: 'session-1',
  turnId: 'turn-1',
  status: 'tracking',
  filesChanged: 3,
  additions: 301,
  deletions: 0,
  binaryFiles: 0,
  truncated: false,
  files: [
    {
      path: 'src/a.ts',
      kind: 'modified',
      additions: 200,
      deletions: 0,
      binary: false,
    },
    {
      path: 'src/b.ts',
      kind: 'modified',
      additions: 101,
      deletions: 0,
      binary: false,
    },
  ],
  seq: 1,
  updatedAt: 1,
}

describe('ComposerProgressStatus', () => {
  it('renders one compact status and toggles the progress popover', async () => {
    container = document.createElement('div')
    document.body.append(container)
    createApp(ComposerProgressStatus, { progress, snapshot }).mount(container)

    const trigger = container.querySelector<HTMLButtonElement>(
      '.composer-progress-trigger',
    )!
    expect(trigger.textContent).toContain(
      'Step 2 / 3 · 3 files changed · +301 −0',
    )
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.composer-progress-popover')).toBeNull()

    trigger.click()
    await nextTick()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelectorAll('.composer-progress-item')).toHaveLength(
      3,
    )

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('opens Review from the popover without losing the compact status', async () => {
    const onOpenReview = vi.fn()
    container = document.createElement('div')
    document.body.append(container)
    createApp(ComposerProgressStatus, {
      progress,
      snapshot,
      onOpenReview,
    }).mount(container)

    container
      .querySelector<HTMLButtonElement>('.composer-progress-trigger')!
      .click()
    await nextTick()
    container
      .querySelector<HTMLButtonElement>('.composer-progress-review')!
      .click()

    expect(onOpenReview).toHaveBeenCalledWith(['src/a.ts', 'src/b.ts'])
  })

  it('opens from keyboard focus and closes after an outside pointer press', async () => {
    container = document.createElement('div')
    document.body.append(container)
    createApp(ComposerProgressStatus, { progress, snapshot }).mount(container)

    const trigger = container.querySelector<HTMLButtonElement>(
      '.composer-progress-trigger',
    )!
    trigger.focus()
    await nextTick()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')

    trigger.click()
    document.body.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true }),
    )
    await nextTick()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })
})
