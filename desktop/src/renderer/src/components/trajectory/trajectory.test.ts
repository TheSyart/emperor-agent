// @vitest-environment jsdom
// Trajectory UI (M7) over the recorded kernel log: ledger rows, folding,
// search, keyboard, the inspector column (tab sets per record kind,
// collapse / reopen), Inspect deep link (incl. paging older history in).
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationScheduler } from '../../conversation/store'
import { settle } from '../../conversation/testing/fixtures'
import {
  FRAME_STORAGE_KEY,
  resetFrameStateForTest,
  useFrameState,
} from '../shell/frameState'
import TrajectoryView from './TrajectoryView.vue'
import { createGalleryStore, type GalleryStore } from './gallery/galleryStore'
import {
  kernelScenario,
  longScenario,
  richScenario,
  type GalleryScenario,
} from './gallery/galleryScenarios'
import { FOCUS_CALL_LOAD_LIMIT, focusCallStep } from './focusCallRetry'
import { ledgerKeyAction } from './tableKeyboard'
import { acquireTrajectory, type TrajectoryController } from './useTrajectory'
import {
  flattenTrajectoryRecords,
  trajectoryRecordId,
} from '../../trajectory/model'

const immediate: ConversationScheduler = {
  frame: (callback) => callback(),
  microtask: (callback) => queueMicrotask(callback),
}

let app: App | null = null
let container: HTMLDivElement | null = null
let gallery: GalleryStore | null = null
let held: { release: () => void } | null = null

beforeEach(() => {
  window.localStorage.removeItem(FRAME_STORAGE_KEY)
  resetFrameStateForTest()
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

afterEach(() => {
  app?.unmount()
  container?.remove()
  held?.release()
  gallery?.dispose()
  app = null
  container = null
  held = null
  gallery = null
})

async function mountScenario(
  scenario: GalleryScenario = kernelScenario(),
  props: Record<string, unknown> = {},
  options: {
    pageEvents?: number
    before?: (controller: TrajectoryController) => void
  } = {},
): Promise<{
  root: HTMLElement
  controller: TrajectoryController
  sessionId: string
}> {
  gallery = createGalleryStore(scenario.sessions, {
    pageEvents: options.pageEvents ?? Number.MAX_SAFE_INTEGER,
    scheduler: immediate,
  })
  const sessionId = scenario.sessions[0]!.id
  const acquired = acquireTrajectory(sessionId, gallery.store)
  held = acquired
  options.before?.(acquired.controller)
  container = document.createElement('div')
  document.body.append(container)
  const store = gallery.store
  app = createApp(() =>
    h('div', { class: 'host' }, [
      h(TrajectoryView, { sessionId, store, ...props }),
    ]),
  )
  app.mount(container)
  await settle(30)
  await nextTick()
  return { root: container, controller: acquired.controller, sessionId }
}

function rows(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('.traj-row')]
}

function tabLabels(root: HTMLElement): string[] {
  return [
    ...root.querySelectorAll<HTMLElement>('.traj-inspector [role="tab"]'),
  ].map((tab) => tab.textContent?.trim() ?? '')
}

describe('TrajectoryTable over the kernel log', () => {
  it('renders one row per ledger record with kind tags and tool text', async () => {
    const { root } = await mountScenario()
    const list = rows(root)
    expect(list.map((row) => row.dataset.kind)).toEqual([
      'system',
      'context',
      'context',
      'context',
      'context',
      'context',
      'user',
      'context',
      'context',
      'message',
      'tool',
      'tool',
      'message',
      'tool',
      'message',
      'tool',
      'message',
      'compacted',
    ])
    const bash = list[10]!
    expect(bash.querySelector('.tool-name')?.textContent).toBe('bash')
    expect(bash.querySelector('.inline-result-text')?.textContent).toContain(
      'alpha',
    )
    expect(list[6]!.textContent).toContain('pick a color (shown)')
    // Turn label on the turn's first content row, and a Between-turns section.
    expect(root.querySelector('.turn-label')?.textContent).toContain('Turn 1')
    expect(root.textContent).toContain('Between turns')
    // Request boundary markers (4 steps + 1 compaction).
    expect(root.querySelectorAll('.traj-request-marker').length).toBe(5)
  })

  it('folds turns and assistant tool calls from the toolbar and summary rows', async () => {
    const { root } = await mountScenario()
    const collapseTurns = root.querySelector<HTMLElement>(
      '[data-fold="turns"]',
    )!
    collapseTurns.click()
    await nextTick()
    const summary = root.querySelector<HTMLElement>(
      '[data-collapsed-summary="turn"]',
    )
    expect(summary?.textContent).toContain('4 steps · 4 tool calls')
    summary!.click()
    await nextTick()
    expect(root.querySelector('[data-collapsed-summary]')).toBeNull()

    root.querySelector<HTMLElement>('[data-fold="calls"]')!.click()
    await nextTick()
    const folded = [
      ...root.querySelectorAll<HTMLElement>(
        '[data-collapsed-summary="assistant"]',
      ),
    ].map((row) => row.textContent?.trim())
    expect(folded).toEqual([
      '…2 tool calls · bash',
      '…1 tool call · ask_user_question',
      '…1 tool call · subagent',
    ])
    expect(
      rows(root).filter((row) => row.dataset.kind === 'tool'),
    ).toHaveLength(0)
  })

  it('filters by search and steps through matches', async () => {
    const { root, controller } = await mountScenario()
    const input = root.querySelector<HTMLInputElement>('input[type="search"]')!
    input.value = 'bash'
    input.dispatchEvent(new Event('input'))
    await new Promise((resolve) => setTimeout(resolve, 150))
    await nextTick()
    const kinds = rows(root).map((row) => row.dataset.kind)
    expect(kinds.length).toBeGreaterThan(0)
    expect(kinds.length).toBeLessThan(18)
    expect(kinds).toContain('tool')
    const count = root.querySelector('[data-search-count]')?.textContent
    expect(count).toMatch(/^–\/\d+$/)
    root.querySelector<HTMLElement>('[aria-label="Next match"]')!.click()
    await nextTick()
    expect(controller.selectedRecord.value).toBeDefined()
    expect(root.querySelector('[data-search-count]')?.textContent).toMatch(
      /^1\//,
    )
  })

  it('moves selection with the keyboard and folds with Left / Right', async () => {
    const { root, controller } = await mountScenario()
    const grid = root.querySelector<HTMLElement>('[role="grid"]')!
    const key = (name: string) =>
      grid.dispatchEvent(
        new KeyboardEvent('keydown', { key: name, bubbles: true }),
      )
    key('Home')
    await nextTick()
    expect(controller.selectedRecord.value?.cell.kind).toBe('system')
    for (let step = 0; step < 9; step++) key('ArrowDown')
    await nextTick()
    expect(controller.selectedRecord.value?.cell.kind).toBe('message')
    key('ArrowLeft')
    await nextTick()
    expect(controller.collapsedAssistants.value.size).toBe(1)
    key('ArrowRight')
    await nextTick()
    expect(controller.collapsedAssistants.value.size).toBe(0)
    key('ArrowLeft')
    key('ArrowLeft')
    await nextTick()
    expect(controller.collapsedTurns.value.has(1)).toBe(true)
    key('Escape')
    await nextTick()
    expect(controller.selection.value).toBeNull()
  })
})

describe('Trajectory inspector column', () => {
  it('shows the tab set of each record kind', async () => {
    const { root, controller } = await mountScenario()
    const expectTabs = async (index: number, tabs: string[]) => {
      controller.selectRecord(index)
      await nextTick()
      expect(tabLabels(root)).toEqual(tabs)
    }
    await expectTabs(1, ['System Prompt', 'Tools'])
    await expectTabs(7, ['Summary', 'Preview', 'Raw', 'Source'])
    // Assistant messages carry no user-role source → no Source tab.
    await expectTabs(10, ['Summary', 'Preview', 'Raw'])
    await expectTabs(11, ['Summary', 'Payload', 'Result', 'Schema', 'Timing'])
    await expectTabs(18, ['Summary', 'Raw Output'])

    const request = controller.requestNumbers.value[0]!
    controller.selectRequest({ turn: request.turn, group: request.group })
    await nextTick()
    expect(tabLabels(root)).toEqual(['Summary', 'Options', 'Usage', 'Timing'])
    expect(
      root.querySelector('.traj-inspector .request-name')?.textContent,
    ).toBe('Request #1')
    controller.activateTab('usage')
    await nextTick()
    const usage =
      root.querySelector('[data-inspector-usage]')?.textContent ?? ''
    expect(usage).toContain('This request')
    expect(usage).toContain('Session cumulative')
    expect(usage).toContain('Cache read')
  })

  it('renders the Diff tab for a changed request header', async () => {
    const { root, controller } = await mountScenario(richScenario())
    const system = controller.records.value.filter(
      (record) => record.cell.kind === 'system',
    )
    const updated = system.find(
      (record) => record.cell.previousPromptDetail !== undefined,
    )
    expect(updated).toBeDefined()
    controller.selectRecord(updated!.cell.index)
    controller.activateTab('diff')
    await nextTick()
    expect(tabLabels(root)).toEqual(['System Prompt', 'Tools', 'Diff'])
    const diff = root.querySelector('.traj-prompt-diff')
    const added = [...(diff?.querySelectorAll('[data-kind="added"]') ?? [])]
      .map((line) => line.textContent)
      .join('\n')
    expect(added).toContain('Session notes')
    expect(diff?.querySelector('[data-kind="removed"]')).not.toBeNull()
  })

  it('links the subagent child session and flags wire truncation', async () => {
    const { root, controller } = await mountScenario(richScenario())
    const subagent = controller.records.value.find(
      (record) => record.cell.childSessionId !== undefined,
    )!
    controller.selectRecord(subagent.cell.index)
    await nextTick()
    const link = root.querySelector<HTMLElement>('[data-link="child-session"]')
    expect(link).not.toBeNull()
    expect(subagent.cell.childSessionId).toBe(kernelScenario().sessions[1]!.id)

    const truncated = controller.records.value.find(
      (record) => record.cell.resultTruncated === true,
    )
    expect(truncated).toBeDefined()
    controller.selectRecord(truncated!.cell.index)
    await nextTick()
    expect(root.querySelector('[data-wire-truncated]')?.textContent).toContain(
      'truncated for transport',
    )
    // The record keeps the seq of the truncated result so the inspector can
    // fetch the full event on demand.
    expect(truncated!.cell.resultEventSeq).toEqual(expect.any(Number))
    expect(root.querySelector('[data-load-full]')?.textContent).toContain(
      '加载完整内容',
    )
  })
})

describe('Inspector column open state', () => {
  function inspector(root: HTMLElement): HTMLElement | null {
    return root.querySelector<HTMLElement>('[aria-label="事件详情"]')
  }
  function toggle(root: HTMLElement): HTMLButtonElement {
    return root.querySelector<HTMLButtonElement>(
      '.traj-toolbar button[aria-label="详情"]',
    )!
  }

  it('stays collapsed until a record is selected, then opens', async () => {
    const { root, controller } = await mountScenario()
    expect(useFrameState().inspectorOpen).toBe(false)
    expect(inspector(root)).toBeNull()
    expect(toggle(root).getAttribute('aria-pressed')).toBe('false')
    controller.selectRecord(11)
    await nextTick()
    expect(useFrameState().inspectorOpen).toBe(true)
    expect(inspector(root)?.textContent).toContain('详情')
    expect(toggle(root).getAttribute('aria-pressed')).toBe('true')
  })

  it('collapses from its header without dropping the selection', async () => {
    const { root, controller } = await mountScenario()
    controller.selectRecord(11)
    await nextTick()
    inspector(root)!
      .querySelector<HTMLButtonElement>('button[aria-label="收起详情"]')!
      .click()
    await nextTick()
    expect(inspector(root)).toBeNull()
    expect(controller.selectedRecord.value?.cell.index).toBe(11)
    toggle(root).click()
    await nextTick()
    expect(tabLabels(root)).toEqual([
      'Summary',
      'Payload',
      'Result',
      'Schema',
      'Timing',
    ])
  })

  it('reopens empty with a hint when nothing is selected', async () => {
    const { root } = await mountScenario()
    toggle(root).click()
    await nextTick()
    expect(inspector(root)?.textContent).toContain(
      '在轨迹中选择一条记录查看详情',
    )
  })

  it('persists a dragged width through frameState', async () => {
    const { root, controller } = await mountScenario()
    controller.selectRecord(11)
    await nextTick()
    const handle = root.querySelector<HTMLElement>(
      '[aria-label="调整详情宽度"]',
    )!
    const before = useFrameState().inspectorWidth
    handle.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
    )
    await nextTick()
    expect(useFrameState().inspectorWidth).toBe(before + 10)
    expect(
      root
        .querySelector<HTMLElement>('.inspector-col')
        ?.style.getPropertyValue('--inspector-width'),
    ).toBe(`${before + 10}px`)
  })
})

describe('Inspect deep link', () => {
  it('focusCall selects the record of the call', async () => {
    const { controller } = await mountScenario()
    expect(controller.focusCall('call_ask')).toBe(true)
    const selected = controller.selectedRecord.value
    expect(selected?.cell.callId).toBe('call_ask')
    expect(selected?.cell.kind).toBe('tool')
    expect(controller.activeTab.value).toBe('overview')
    expect(controller.focusCall('missing')).toBe(false)
  })

  it('applies focusCallId once loaded, unfolding the owning turn', async () => {
    const scenario = kernelScenario()
    const emitted: string[] = []
    const { root, controller } = await mountScenario(scenario, {
      focusCallId: 'call_bash_b',
      onInspectApplied: (callId: string) => emitted.push(callId),
    })
    expect(emitted).toEqual(['call_bash_b'])
    expect(controller.selectedRecord.value?.cell.callId).toBe('call_bash_b')
    expect(
      root.querySelector('.traj-row[data-selected="true"] .tool-args')
        ?.textContent,
    ).toContain('echo beta')
    expect(useFrameState().inspectorOpen).toBe(true)
  })

  it('pages older history in until the call is loaded', async () => {
    const emitted: string[] = []
    const { controller } = await mountScenario(
      longScenario(6),
      {
        focusCallId: 'call_bash_a',
        onInspectApplied: (callId: string) => emitted.push(callId),
      },
      { pageEvents: 80 },
    )
    await vi.waitFor(() => expect(emitted).toEqual(['call_bash_a']))
    expect(controller.selectedRecord.value?.cell.callId).toBe('call_bash_a')
  })

  it('gives up after a bounded number of older pages', async () => {
    const emitted: string[] = []
    let loads = 0
    const { controller } = await mountScenario(
      longScenario(40),
      {
        focusCallId: 'call_bash_a',
        onInspectApplied: (callId: string) => emitted.push(callId),
      },
      {
        pageEvents: 40,
        before: (target) => {
          const load = target.loadOlder
          target.loadOlder = () => {
            loads++
            return load()
          }
        },
      },
    )
    await vi.waitFor(() => expect(loads).toBe(FOCUS_CALL_LOAD_LIMIT))
    await settle(30)
    expect(loads).toBe(FOCUS_CALL_LOAD_LIMIT)
    expect(controller.windowState.value.hasMore).toBe(true)
    expect(emitted).toEqual([])
  })
})

describe('focusCallStep', () => {
  const open = { openState: 'open', hasMore: true, loadingOlder: false }
  it('waits for the window, loads older pages, then gives up', () => {
    expect(focusCallStep({ ...open, openState: 'opening' }, 0)).toBe('wait')
    expect(focusCallStep({ ...open, loadingOlder: true }, 0)).toBe('wait')
    expect(focusCallStep(open, 0)).toBe('load-older')
    expect(focusCallStep(open, FOCUS_CALL_LOAD_LIMIT - 1)).toBe('load-older')
    expect(focusCallStep(open, FOCUS_CALL_LOAD_LIMIT)).toBe('give-up')
    expect(focusCallStep({ ...open, hasMore: false }, 0)).toBe('give-up')
  })
})

describe('ledgerKeyAction', () => {
  it('maps navigation and fold keys', async () => {
    const { controller } = await mountScenario()
    const records = flattenTrajectoryRecords(controller.turns.value)
    const context = {
      rows: records,
      position: 9,
      records,
      collapsedTurns: new Set<number>(),
      collapsedAssistants: new Set<string>(),
    }
    expect(ledgerKeyAction('ArrowDown', context)).toEqual({
      kind: 'move',
      position: 10,
    })
    expect(ledgerKeyAction('End', context)).toEqual({
      kind: 'move',
      position: records.length - 1,
    })
    expect(ledgerKeyAction('Enter', context)).toEqual({
      kind: 'select',
      index: records[9]!.cell.index,
    })
    expect(ledgerKeyAction('ArrowLeft', context)).toEqual({
      kind: 'toggle-assistant',
      id: trajectoryRecordId(records[9]!.cell),
    })
    expect(ledgerKeyAction('ArrowLeft', { ...context, position: 6 })).toEqual({
      kind: 'toggle-turn',
      turn: 1,
    })
  })
})
