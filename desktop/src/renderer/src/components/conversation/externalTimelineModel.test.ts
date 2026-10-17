import { expect, it } from 'vitest'
import type { ExternalHistoryEntry } from './externalHistoryFeed'
import {
  externalTimelineRows,
  externalToolStatusLabel,
} from './externalTimelineModel'

const start: ExternalHistoryEntry = {
  id: 'r1:0:0',
  runId: 'r1',
  type: 'tool',
  toolId: 'call_a',
  name: 'Read',
  status: 'running',
  text: '公开读取要求',
}
const finish: ExternalHistoryEntry = {
  id: 'r1:100:0',
  runId: 'r1',
  type: 'tool',
  toolId: 'call_a',
  status: 'completed',
  text: '公开读取结果',
}
const fold = (entries: readonly ExternalHistoryEntry[]) =>
  externalTimelineRows(entries, ['r1', 'r2'])
const tools = (entries: readonly ExternalHistoryEntry[]) =>
  fold(entries).filter(
    (row): row is ExternalHistoryEntry => row.type === 'tool',
  )

it.each([
  ['running', '运行中'],
  ['completed', '已完成'],
  ['failed', '失败'],
  ['interrupted', '已中断'],
  ['cancelled', '已取消'],
  ['provider_paused', '状态：provider_paused'],
  [undefined, '状态未记录'],
])('renders recorded tool status %s truthfully as %s', (status, label) => {
  expect(externalToolStatusLabel(status)).toBe(label)
})

it('correlates a live completion without changing its presentation identity or durable inputs', () => {
  const original = structuredClone([start, finish])
  const initial = tools([start])[0]!
  const completed = tools([start, finish])
  expect(completed).toHaveLength(1)
  expect(completed[0]).toMatchObject({
    id: initial.id,
    name: 'Read',
    status: 'completed',
    toolId: 'call_a',
    runId: 'r1',
  })
  expect(completed[0]!.text).toContain('公开读取要求')
  expect(completed[0]!.text).toContain('公开读取结果')
  expect([start, finish]).toEqual(original)
})

it('finishes the matching interleaved activity and preserves the other running tool', () => {
  const rows = tools([
    start,
    { ...start, id: 'r1:30:0', toolId: 'call_b', name: 'Write' },
    finish,
  ])
  expect(rows).toHaveLength(2)
  expect(rows[0]).toMatchObject({
    toolId: 'call_a',
    status: 'completed',
    name: 'Read',
  })
  expect(rows[1]).toMatchObject({
    toolId: 'call_b',
    status: 'running',
    name: 'Write',
  })
})

it('keeps the same tool ID in separate runs as independent activities with unique keys', () => {
  const rows = tools([start, { ...finish, id: 'r2:0:0', runId: 'r2' }])
  expect(rows).toHaveLength(2)
  expect(rows[0]).toMatchObject({ runId: 'r1', status: 'running' })
  expect(rows[1]).toMatchObject({ runId: 'r2', status: 'completed' })
  expect(rows[1]!.name).toBeUndefined()
  expect(rows[0]!.id).not.toBe(rows[1]!.id)
})

it('keeps finish-only identity when an older page supplies the start and its name', () => {
  const initial = tools([finish])[0]!
  expect(initial).toMatchObject({ status: 'completed', text: '公开读取结果' })
  expect(initial.name).toBeUndefined()
  const paged = tools([start, finish])
  expect(paged).toHaveLength(1)
  expect(paged[0]).toMatchObject({
    id: initial.id,
    status: 'completed',
    name: 'Read',
  })
})

it('never guesses associations for absent, empty, or whitespace-only legacy IDs', () => {
  for (const toolId of [undefined, '', '   ']) {
    const entries = [
      { ...start, toolId },
      { ...finish, toolId },
    ]
    expect(tools(entries)).toEqual(entries)
  }
})

it('does not replace recorded status or name with omitted fields, or invent a terminal result', () => {
  const rows = tools([
    start,
    { ...finish, status: 'provider_paused' },
    { ...finish, id: 'r1:200:0', name: '', status: undefined, text: undefined },
  ])
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ name: 'Read', status: 'provider_paused' })
  expect(tools([start])[0]).toMatchObject({
    name: 'Read',
    status: 'running',
    text: '公开读取要求',
  })
})

it('retains text grouping boundaries, run headings and question positions', () => {
  const rows = fold([
    { id: 't1', runId: 'r1', type: 'text', text: 'a'.repeat(32767) },
    { id: 't2', runId: 'r1', type: 'text', text: 'b' },
    { id: 't3', runId: 'r1', type: 'text', text: 'c' },
    { id: 'q', runId: 'r1', type: 'question', text: '问题' },
    { id: 't4', runId: 'r2', type: 'text', text: '下一轮' },
  ])
  expect(rows.map(({ id, type }) => [id, type])).toEqual([
    ['r1:heading', 'run'],
    ['t1', 'text'],
    ['t3', 'text'],
    ['q', 'question'],
    ['r2:heading', 'run'],
    ['t4', 'text'],
  ])
  expect(rows[1]!.text).toBe('a'.repeat(32767) + 'b')
  expect(rows[4]!.text).toBe('第 2 轮')
})

it('keeps every public tool detail while bounding each virtual row after a large result', () => {
  const rows = fold([
    start,
    { ...finish, text: '结'.repeat(32768) },
    { ...finish, id: 'r1:100:1', text: '尾部' },
  ])
  expect(rows.filter((row) => row.type === 'tool')).toHaveLength(1)
  expect(rows.every((row) => (row.text?.length ?? 0) <= 32768)).toBe(true)
  const details = rows
    .filter((row) => row.type === 'tool' || row.type === 'tool-detail')
    .map((row) => row.text)
    .join('')
  expect(details).toContain('公开读取要求')
  expect(details).toContain('结'.repeat(32768))
  expect(details).toContain('尾部')
  expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length)
})
