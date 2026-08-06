// @vitest-environment jsdom
import { createApp, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ControlInteraction } from '../../types'
import PlanCard from './PlanCard.vue'

let container: HTMLDivElement | null = null

afterEach(() => {
  container?.remove()
  container = null
  vi.unstubAllGlobals()
})

function interaction(
  extra: Partial<ControlInteraction> = {},
): ControlInteraction {
  return {
    id: 'plan-1',
    kind: 'plan',
    status: 'waiting',
    title: '重构聊天流线',
    plan_markdown: '# 目标\n\n第一步\n\n第二步',
    risk_level: 'medium',
    ...extra,
  }
}

function mount(extra: Partial<ControlInteraction> = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  createApp(PlanCard, { interaction: interaction(extra), plan: null }).mount(
    container,
  )
  return container
}

describe('PlanCard', () => {
  it('removes the redundant raw status footnote (hero chip already carries it)', () => {
    const root = mount()
    expect(root.querySelector('.control-footnote')).toBeNull()
    expect(root.textContent).not.toContain('状态：')
  })

  it('copies the plan markdown and swaps to the check icon', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const root = mount()

    const copyButton = root.querySelector<HTMLButtonElement>(
      '.plan-card-actions .plan-card-icon-button',
    )!
    copyButton.click()
    await nextTick()
    await nextTick()

    expect(writeText).toHaveBeenCalledWith('# 目标\n\n第一步\n\n第二步')
    expect(copyButton.getAttribute('aria-label')).toBe('已复制')
  })

  it('toggles the collapsed class on the markdown body', async () => {
    const root = mount()
    const markdown = () => root.querySelector('.plan-markdown-primary')!
    expect(markdown().classList.contains('plan-markdown-collapsed')).toBe(false)

    const toggle = root.querySelectorAll<HTMLButtonElement>(
      '.plan-card-actions .plan-card-icon-button',
    )[1]!
    toggle.click()
    await nextTick()
    expect(markdown().classList.contains('plan-markdown-collapsed')).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    toggle.click()
    await nextTick()
    expect(markdown().classList.contains('plan-markdown-collapsed')).toBe(false)
  })
})
