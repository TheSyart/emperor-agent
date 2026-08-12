// @vitest-environment jsdom
import { createApp } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import type { TurnChangeSnapshot } from '../../types'
import TurnChangesCard from './TurnChangesCard.vue'

let container: HTMLDivElement | null = null

afterEach(() => {
  container?.remove()
  container = null
})

const snapshot: TurnChangeSnapshot = {
  version: 2,
  sessionId: 'session-1',
  turnId: 'turn-1',
  status: 'partial',
  filesChanged: 1,
  additions: 12,
  deletions: 3,
  binaryFiles: 0,
  truncated: false,
  files: [
    {
      path: 'src/a.ts',
      kind: 'modified',
      additions: 12,
      deletions: 3,
      binary: false,
    },
  ],
  seq: 1,
  updatedAt: 1,
}

describe('TurnChangesCard', () => {
  it('keeps partial wording without rendering the yellow attribution warning', () => {
    container = document.createElement('div')
    document.body.append(container)
    createApp(TurnChangesCard, { snapshot }).mount(container)

    expect(container.textContent).toContain('已确认修改 1 个文件')
    expect(container.querySelector('.turn-changes-partial')).toBeNull()
    expect(container.textContent).not.toContain('仅展示可精确归因的变更')
  })

  it('groups header and file-level additions and deletions with spacing containers', () => {
    container = document.createElement('div')
    document.body.append(container)
    createApp(TurnChangesCard, { snapshot }).mount(container)

    const pairs = container.querySelectorAll('.diff-stat-pair')
    expect(pairs).toHaveLength(2)
    for (const pair of pairs) {
      expect(pair.querySelector('.stat-add')?.textContent).toBe('+12')
      expect(pair.querySelector('.stat-del')?.textContent).toBe('−3')
    }
  })
})
