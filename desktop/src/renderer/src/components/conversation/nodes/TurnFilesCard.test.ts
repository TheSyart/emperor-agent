// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick } from 'vue'
import type { TurnFilesChatData } from '../../../conversation/types'

const { core, requestWorkspace } = vi.hoisted(() => ({
  core: vi.fn(),
  requestWorkspace: vi.fn(),
}))
vi.mock('../../../api/http', () => ({ core }))
vi.mock('../../workspace/workspaceState', () => ({ requestWorkspace }))

import { createExpansionStore, provideChatContext } from '../chatContext'
import TurnFilesCard from './TurnFilesCard.vue'

let container: HTMLDivElement | null = null

beforeEach(() => {
  core.mockReset()
  requestWorkspace.mockReset()
})

afterEach(() => {
  container?.remove()
  container = null
  document.body.innerHTML = ''
})

const files: TurnFilesChatData['files'] = [
  { path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1 },
  { path: 'src/b.ts', status: 'added', additions: 5, deletions: 0 },
  { path: 'docs/old.md', status: 'deleted', additions: 0, deletions: 4 },
  {
    path: 'logo.png',
    status: 'added',
    additions: null,
    deletions: null,
    binary: true,
  },
  {
    path: 'c.ts',
    oldPath: 'b0.ts',
    status: 'renamed',
    additions: 0,
    deletions: 0,
  },
  {
    path: 'big.log',
    status: 'added',
    additions: null,
    deletions: null,
    tooLarge: true,
  },
  { path: 'z.ts', status: 'modified', additions: 1, deletions: 1 },
]

function data(patch: Partial<TurnFilesChatData> = {}): TurnFilesChatData {
  return {
    turn: 3,
    mode: 'git',
    status: 'recorded',
    files,
    totals: { files: 7, additions: 9, deletions: 6 },
    truncated: false,
    concurrent: false,
    reviewable: true,
    ...patch,
  }
}

function mount(value: TurnFilesChatData): HTMLDivElement {
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
      return () =>
        h(TurnFilesCard, {
          node: {
            key: 'turnFiles:3',
            kind: 'turnFiles',
            id: '3',
            target: 'chat',
            anchorSeq: 10.5,
            visibility: 'visible',
            turn: 3,
            step: null,
            data: value,
          },
        })
    },
  })
  createApp(Host).mount(container)
  return container
}

const rowNames = (root: HTMLElement) =>
  [...root.querySelectorAll('.file .name')].map((el) => el.textContent)

async function flush() {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('TurnFilesCard', () => {
  it('sums up the turn and lists the first files', async () => {
    const root = mount(data())
    expect(root.querySelector('.headline')?.textContent).toBe('已编辑 7 个文件')
    expect(root.querySelector('.head .add')?.textContent).toBe('+9')
    expect(root.querySelector('.head .del')?.textContent).toBe('−6')
    expect(rowNames(root)).toEqual(['a.ts', 'b.ts', 'old.md'])
    expect(root.querySelector('.file .dir')?.textContent).toBe('src/')
    const text = root.textContent ?? ''
    expect(text).toContain('新建')
    expect(text).toContain('删除')
    expect(root.querySelector('.scope-info')?.getAttribute('aria-label')).toBe(
      '按本轮开始与结束时的项目对比',
    )
    expect(root.querySelector('.more')?.textContent).toContain(
      '再显示 4 个文件',
    )
    root.querySelector<HTMLButtonElement>('.more')!.click()
    await flush()
    expect(rowNames(root)).toHaveLength(7)
    expect(root.textContent).toContain('二进制')
    expect(root.textContent).toContain('由 b0.ts 重命名')
    expect(root.textContent).toContain('过大，未记录内容')
  })

  it('keeps review separate from current file preview', async () => {
    const root = mount(data())
    root.querySelector<HTMLButtonElement>('[data-action="review"]')!.click()
    expect(requestWorkspace).toHaveBeenLastCalledWith({
      pane: 'review',
      turn: { sessionId: 's1', turn: 3, files },
    })
    root.querySelectorAll<HTMLButtonElement>('.file')[1]!.click()
    expect(requestWorkspace).toHaveBeenLastCalledWith({
      pane: 'files',
      file: {
        owner: 's1',
        target: { source: 'turn', sessionId: 's1', turn: 3, path: 'src/b.ts' },
      },
    })
  })

  it('asks before undoing, with files that can be left out', async () => {
    core.mockResolvedValue({ turn: 3, reverted: ['src/a.ts'], skipped: [] })
    const root = mount(data({ concurrent: true }))
    root.querySelector<HTMLButtonElement>('[data-action="undo"]')!.click()
    await flush()
    const dialog = document.body.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('撤销这一轮的改动？')
    expect(dialog.querySelector('[data-turn-revert-concurrent]')).not.toBeNull()
    const boxes = [
      ...dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ]
    expect(boxes).toHaveLength(7)
    // The large file was never stored: it cannot be chosen.
    expect(boxes[5]!.disabled).toBe(true)
    expect(boxes.filter((box) => box.checked)).toHaveLength(6)
    boxes[1]!.click()
    await flush()
    const confirm = dialog.querySelector<HTMLButtonElement>(
      '[data-action="confirm"]',
    )!
    expect(confirm.textContent?.trim()).toBe('撤销 5 个文件')
    confirm.click()
    await flush()
    expect(core).toHaveBeenCalledWith('workspace.revertTurn', {
      sessionId: 's1',
      turn: 3,
      paths: ['src/a.ts', 'docs/old.md', 'logo.png', 'c.ts', 'z.ts'],
    })
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('keeps the dialog open with the reason when undo is refused', async () => {
    core.mockRejectedValue(
      new Error('这个工作区有 Agent 正在运行，等它结束后再撤销。'),
    )
    const root = mount(data())
    root.querySelector<HTMLButtonElement>('[data-action="undo"]')!.click()
    await flush()
    document.body
      .querySelector<HTMLButtonElement>('[data-action="confirm"]')!
      .click()
    await flush()
    expect(
      document.body.querySelector('[role="alert"]')?.textContent,
    ).toContain('Agent 正在运行')
  })

  it('shows an undone turn with what was skipped', () => {
    const root = mount(
      data({
        reverted: {
          reverted: ['src/a.ts', 'src/b.ts'],
          skipped: [{ path: 'docs/old.md', reason: 'changed-since' }],
        },
      }),
    )
    expect(root.querySelector('[data-state="reverted"]')).not.toBeNull()
    expect(root.querySelector('.reverted')?.textContent?.trim()).toBe(
      '已撤销，跳过 1 个',
    )
    expect(root.querySelector('[data-action="undo"]')).toBeNull()
    expect(root.textContent).toContain('已恢复')
    expect(root.textContent).toContain('之后又改过，已跳过')
  })

  it('says when a turn was not recorded, and previews files outside Git', async () => {
    const skipped = mount(
      data({
        status: 'skipped',
        skipReason: 'timeout',
        files: [],
        totals: { files: 0, additions: 0, deletions: 0 },
        reviewable: false,
      }),
    )
    expect(skipped.textContent?.trim()).toBe(
      '本轮改动未记录：项目快照超过 5 秒',
    )
    container?.remove()
    const tools = mount(data({ mode: 'tools', reviewable: false }))
    expect(tools.querySelector('[data-action="review"]')).toBeNull()
    expect(tools.querySelector('[data-action="undo"]')).toBeNull()
    expect(tools.querySelector('.scope-info')?.getAttribute('aria-label')).toBe(
      '只统计 Emperor 文件工具写入的文件',
    )
    tools.querySelectorAll<HTMLButtonElement>('.file')[0]!.click()
    expect(requestWorkspace).toHaveBeenLastCalledWith({
      pane: 'files',
      file: {
        owner: 's1',
        target: { source: 'turn', sessionId: 's1', turn: 3, path: 'src/a.ts' },
      },
    })
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('keeps a single-file summary compact without an empty footer', () => {
    const root = mount(
      data({
        mode: 'tools',
        reviewable: false,
        files: [files[0]!],
        totals: { files: 1, additions: 3, deletions: 1 },
      }),
    )
    expect(root.querySelector('.headline')?.textContent).toBe('已编辑 1 个文件')
    expect(root.querySelector('.totals')?.getAttribute('aria-label')).toBe(
      '新增 3 行，删除 1 行',
    )
    expect(root.querySelector('.foot')).toBeNull()
    expect(root.querySelector('.file .document-icon')).not.toBeNull()
    expect(root.textContent).not.toContain('只统计')
  })
})
