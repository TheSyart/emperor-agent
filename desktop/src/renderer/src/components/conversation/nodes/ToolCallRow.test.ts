// @vitest-environment jsdom
/**
 * BUG-02: a plan is shown in full once. While it waits for the user the
 * conversation row stays one line (the review card below holds the plan);
 * once decided the row opens; a row the reader opened stays open.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  createApp,
  defineComponent,
  h,
  nextTick,
  shallowRef,
  type Component,
  type Ref,
} from 'vue'
import type { ToolChatData } from '../../../conversation/types'
import { createExpansionStore, provideChatContext } from '../chatContext'
import ToolCallRow from './ToolCallRow.vue'

let container: HTMLDivElement | null = null
afterEach(() => {
  container?.remove()
  container = null
})

const PLAN = '# 给 README 加一节安装说明\n\n1. 在「快速开始」前加「安装」一节'

function plan(result?: { text: string; meta?: unknown }): ToolChatData {
  return {
    callId: 'call-plan',
    name: 'exit_plan_mode',
    argsRaw: JSON.stringify({ plan: PLAN }),
    turn: 1,
    step: 1,
    time: 0,
    status: result === undefined ? 'running' : 'settled',
    approvals: [],
    ...(result === undefined
      ? {}
      : {
          result: {
            seq: 1,
            time: 1,
            content: [{ type: 'text', text: result.text }],
            isError: false,
            ...(result.meta === undefined
              ? {}
              : { meta: result.meta as never }),
          },
        }),
  } as ToolChatData
}

function mount(data: Ref<ToolChatData>): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  const Host = defineComponent({
    setup() {
      provideChatContext({
        actions: {
          inspect: () => undefined,
          openSubagent: () => undefined,
          editMessage: () => undefined,
        },
        expansion: createExpansionStore(),
        sessionId: () => 's1',
      })
      // A plain Component keeps tsc from expanding the SFC's prop types.
      return () => h(ToolCallRow as Component, { data: data.value })
    },
  })
  createApp(Host).mount(container)
  return container
}

const expanded = (root: HTMLElement) =>
  root.querySelector('[aria-expanded]')?.getAttribute('aria-expanded')

describe('ToolCallRow · exit_plan_mode (BUG-02)', () => {
  it('stays one line while the plan waits for the review card below', () => {
    const root = mount(shallowRef(plan()))
    expect(expanded(root)).toBe('false')
    expect(root.querySelector('.body')).toBeNull()
    expect(root.textContent).toContain('给 README 加一节安装说明')
    expect(root.textContent).toContain('等待你在下方确认')
  })

  it('opens by itself once the plan is approved', async () => {
    const data = shallowRef(plan())
    const root = mount(data)
    expect(expanded(root)).toBe('false')
    data.value = plan({ text: 'ok', meta: { approved: true } })
    await nextTick()
    expect(expanded(root)).toBe('true')
    expect(root.querySelector('.body')).not.toBeNull()
  })

  it('opens a decided plan from history', () => {
    const root = mount(
      shallowRef(plan({ text: 'ok', meta: { approved: true } })),
    )
    expect(expanded(root)).toBe('true')
  })

  it('keeps a row the reader opened while waiting', async () => {
    const root = mount(shallowRef(plan()))
    root.querySelector<HTMLElement>('[aria-expanded]')!.click()
    await nextTick()
    expect(expanded(root)).toBe('true')
  })
})
