// UI-S03 process groups (DSH-22 / DSH-23): the pure row model ChatTimeline
// renders — one process row per turn between the prompt and the answer,
// its step count, live label and duration, and the preparing calls.
import { describe, expect, it } from 'vitest'
import type { ChatNode, ChatSnapshot } from '../../conversation/types'
import {
  LogBuilder,
  loadKernelLog,
  replay,
  stream,
} from '../../conversation/testing/fixtures'
import { loadScenario } from '../../conversation/testing/scenario'
import { formatRunDuration } from './chatFormat'
import {
  linksScenario,
  noticesScenario,
  showcaseScenario,
  streamingScenario,
} from './gallery/scenarios'
import {
  processExpansionKey,
  processLiveStep,
  processSummary,
  preparingToolData,
  rowIndexOf,
  rowNodeKey,
  timelineRowsOf,
  type AgentsRow,
  type ProcessRow,
  type TimelineRow,
} from './processModel'
import { partialJsonObject } from './tools/toolModel'

function snapshotOf(events: Parameters<typeof replay>[0]): ChatSnapshot {
  return replay(events).snapshot
}

function describeRow(row: TimelineRow, nodes: ChatSnapshot['nodes']): string {
  if (row.kind === 'agents')
    return `agents: ${row.members
      .map((key) => {
        const node = nodes.get(key) as ChatNode
        return node.kind === 'tool' ? `tool:${node.data.name}` : node.kind
      })
      .join(' ')}`
  if (row.kind === 'node') {
    const node = nodes.get(row.id) as ChatNode
    const label =
      node.kind === 'tool' ? `tool:${node.data.name}` : (node.kind as string)
    const flags = [row.answerOnly && 'answer', row.closing && 'closing']
      .filter(Boolean)
      .join(',')
    return flags ? `${label}(${flags})` : label
  }
  const members = row.members.map((member) => {
    if (member.kind === 'preparing') return `preparing:${member.index}`
    const node = nodes.get(member.key) as ChatNode
    const label =
      node.kind === 'tool' ? `tool:${node.data.name}` : (node.kind as string)
    return member.reasoningOnly ? `${label}(reasoning)` : label
  })
  return `process[${row.live ? 'live' : 'done'}] steps=${row.steps}: ${members.join(' ')}`
}

function describeRows(
  snapshot: ChatSnapshot,
  options: { showSystemSteps?: boolean } = {},
): string[] {
  return timelineRowsOf(snapshot, {
    showSystemSteps: options.showSystemSteps ?? false,
  }).map((row) => describeRow(row, snapshot.nodes))
}

function processRows(
  snapshot: ChatSnapshot,
  showSystemSteps = false,
): ProcessRow[] {
  return timelineRowsOf(snapshot, { showSystemSteps }).filter(
    (row): row is ProcessRow => row.kind === 'process',
  )
}

describe('process rows (DSH-22)', () => {
  it('folds a finished turn into one process row before the answer', () => {
    const scenario = showcaseScenario(1_800_000_000_000)
    const snapshot = snapshotOf(scenario.sessions[0]!.events)
    expect(describeRows(snapshot)).toEqual([
      'user',
      // UI-S14: the subagent leaves the process for a row of its own.
      'process[done] steps=10: assistant tool:grep tool:read assistant tool:edit assistant tool:write tool:todo_write tool:bash tool:bash tool:glob assistant tool:web_search',
      'agents: tool:subagent',
      'assistant(closing)',
      'turnTail',
    ])
    const [process] = processRows(snapshot)
    const tail = [...snapshot.nodes.values()].find(
      (node) => node.kind === 'turnTail',
    )
    expect(tail?.kind).toBe('turnTail')
    const duration = tail?.kind === 'turnTail' ? tail.data.durationMs : 0
    expect(process!.endedAt! - process!.startedAt!).toBe(duration)
    expect(processSummary(process!)).toBe(
      `已处理 10 步 · 用时 ${formatRunDuration(duration ?? 0)}`,
    )
  })

  it('counts one step per thinking block, tool call and system row', () => {
    const scenario = showcaseScenario(1_800_000_000_000)
    const snapshot = snapshotOf(scenario.sessions[0]!.events)
    const [process] = processRows(snapshot)
    const tools = process!.members.filter(
      (member) =>
        member.kind === 'node' &&
        snapshot.nodes.get(member.key)?.kind === 'tool',
    )
    // 9 tool calls + the first step's thinking (the subagent has its own row).
    expect(tools).toHaveLength(9)
    expect(process!.steps).toBe(10)
  })

  it('lists context and hooks only with 显示系统步骤', () => {
    const scenario = showcaseScenario(1_800_000_000_000)
    const snapshot = snapshotOf(scenario.sessions[0]!.events)
    expect(describeRows(snapshot).join('\n')).not.toContain('context')
    const [shown] = processRows(snapshot, true)
    expect(snapshot.nodes.get(shown!.members[0]!.key)?.kind).toBe('context')
    expect(shown!.steps).toBe(11)

    const notices = snapshotOf(
      noticesScenario(1_800_000_000_000).sessions[0]!.events,
    )
    const hidden = describeRows(notices).join('\n')
    expect(hidden).not.toContain('hook')
    expect(hidden).not.toContain('context')
    expect(
      describeRows(notices, { showSystemSteps: true }).join('\n'),
    ).toContain('hook')
  })

  it('keeps a turn without tool calls as plain rows', () => {
    const snapshot = snapshotOf(
      linksScenario(1_800_000_000_000).sessions[0]!.events,
    )
    expect(describeRows(snapshot)).toEqual([
      'user',
      'assistant(closing)',
      'turnTail',
    ])
  })

  it('ends the turn with its footer, after the files card (UI-S13)', () => {
    const log = new LogBuilder()
    log.user('u1', 'fix it')
    log.add('turn/start', { turn: 1 })
    log.add('step/start', { turn: 1, step: 1 })
    log.message(1, 1, [
      { type: 'tool-call', id: 'w', name: 'write', arguments: '{}' },
    ])
    log.call(1, 1, 'w', 'write', { file_path: 'a.ts' })
    log.result(1, 1, 'w', 'ok')
    log.add('step/end', { turn: 1, step: 1 })
    log.add('step/start', { turn: 1, step: 2 })
    log.message(1, 2, [{ type: 'text', text: 'done' }])
    log.add('step/end', { turn: 1, step: 2 })
    log.add('turn/end', { turn: 1, reason: { kind: 'completed' } })
    // The snapshot lands after the next prompt.
    log.user('u2', 'next')
    log.add('turn/files', {
      turn: 1,
      mode: 'git',
      status: 'recorded',
      files: [{ path: 'a.ts', status: 'added', additions: 1, deletions: 0 }],
      totals: { files: 1, additions: 1, deletions: 0 },
      snapshot: { before: 'b'.repeat(40), after: 'a'.repeat(40) },
    })
    const snapshot = snapshotOf(log.events)
    // The answer still counts as closing: its copy action lives in the
    // footer, with the files card between them.
    expect(describeRows(snapshot)).toEqual([
      'user',
      'process[done] steps=1: tool:write',
      'assistant(closing)',
      'turnFiles',
      'turnTail',
      'user',
    ])
  })

  it('moves the answer’s thinking into the process row', () => {
    const snapshot = snapshotOf(loadScenario('fresh-round-trip'))
    expect(describeRows(snapshot)).toEqual([
      'user',
      'process[done] steps=3: assistant tool:bash assistant(reasoning)',
      'assistant(answer,closing)',
      'turnTail',
    ])
  })

  it('splits the process around a steering message', () => {
    const log = new LogBuilder()
    log.user('u1', 'first')
    log.add('turn/start', { turn: 1 })
    log.add('step/start', { turn: 1, step: 1 })
    log.message(1, 1, [
      { type: 'tool-call', id: 'a', name: 'read', arguments: '{}' },
    ])
    log.call(1, 1, 'a', 'read', { file_path: 'a.ts' })
    log.result(1, 1, 'a', 'ok')
    log.add('step/end', { turn: 1, step: 1 })
    const steering = log.user('u2', 'also b')
    log.add('step/start', { turn: 1, step: 2 })
    log.message(1, 2, [
      { type: 'tool-call', id: 'b', name: 'read', arguments: '{}' },
    ])
    log.call(1, 2, 'b', 'read', { file_path: 'b.ts' })
    log.result(1, 2, 'b', 'ok')
    log.add('step/end', { turn: 1, step: 2 })
    log.add('step/start', { turn: 1, step: 3 })
    log.message(1, 3, [{ type: 'text', text: 'done' }])
    log.add('step/end', { turn: 1, step: 3 })
    log.add('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const snapshot = snapshotOf(log.events)
    expect(describeRows(snapshot)).toEqual([
      'user',
      'process[done] steps=1: tool:read',
      'user',
      'process[done] steps=1: tool:read',
      'assistant(closing)',
      'turnTail',
    ])
    const [first, second] = processRows(snapshot)
    expect(first!.endedAt).toBe(steering.time)
    expect(first!.id).not.toBe(second!.id)
  })

  it('makes the running turn’s process row live and names the current step', () => {
    const scenario = streamingScenario(1_800_000_000_000, 'all')
    const session = scenario.sessions[0]!
    expect(describeRows(snapshotOf(session.events))).toEqual(['user'])
    const live = snapshotOf([...session.events, ...(session.live ?? [])])
    expect(describeRows(live)).toEqual([
      'user',
      'process[live] steps=2: assistant tool:read',
    ])
    const [process] = processRows(live)
    expect(processLiveStep(process!, live.nodes)).toEqual({
      label: '正在读取 store.ts',
      ordinal: 2,
    })
  })

  it('a live process waiting for the next step thinks about step N + 1', () => {
    const log = new LogBuilder()
    log.user('u1', 'go')
    log.add('turn/start', { turn: 1 })
    log.add('step/start', { turn: 1, step: 1 })
    log.message(1, 1, [
      { type: 'tool-call', id: 'a', name: 'grep', arguments: '{}' },
    ])
    log.call(1, 1, 'a', 'grep', { pattern: 'x' })
    log.result(1, 1, 'a', 'ok')
    log.add('step/end', { turn: 1, step: 1 })
    const snapshot = snapshotOf(log.events)
    const [process] = processRows(snapshot)
    expect(process!.live).toBe(true)
    expect(processLiveStep(process!, snapshot.nodes)).toEqual({
      label: '正在思考',
      ordinal: 2,
    })
  })

  it('stops being live once the answer streams, then times the process', () => {
    const scenario = showcaseScenario(1_800_000_000_000)
    const events = scenario.sessions[0]!.events
    const end = events.findIndex((event) => event.type === 'turn/end')
    const answering = snapshotOf(events.slice(0, end))
    const [process] = processRows(answering)
    expect(process!.live).toBe(false)
    expect(process!.endedAt).not.toBeNull()
    // The subagent has its own row (UI-S14): the process ends where it starts.
    expect(processSummary(process!)).toMatch(/^已处理 10 步 · 用时 /)
  })

  it('reuses the previous rows when nothing structural changed', () => {
    const snapshot = snapshotOf(
      showcaseScenario(1_800_000_000_000).sessions[0]!.events,
    )
    const first = timelineRowsOf(snapshot, { showSystemSteps: false })
    expect(timelineRowsOf(snapshot, { showSystemSteps: false }, first)).toBe(
      first,
    )
    const shown = timelineRowsOf(snapshot, { showSystemSteps: true }, first)
    expect(shown).not.toBe(first)
    // Unchanged rows keep their identity.
    expect(shown[0]).toBe(first[0])
  })

  it('projects the recorded kernel log (golden)', () => {
    const snapshot = snapshotOf(loadKernelLog().root.events)
    expect(describeRows(snapshot)).toEqual([
      'user',
      'process[done] steps=5: retry assistant tool:bash tool:bash tool:ask_user_question',
      'agents: tool:subagent',
      'assistant(closing)',
      'turnTail',
      'compaction',
    ])
    expect(describeRows(snapshot, { showSystemSteps: true })).toEqual([
      'user',
      'process[done] steps=7: context context retry assistant tool:bash tool:bash tool:ask_user_question',
      'agents: tool:subagent',
      'assistant(closing)',
      'turnTail',
      'compaction',
    ])
  })

  it('keys the disclosure by the 处理过程 preference', () => {
    const row = { id: 'process:1:0', live: true } as ProcessRow
    const done = { ...row, live: false }
    expect(processExpansionKey(row, 'collapse-when-done')).toEqual({
      key: 'process:1:0:live',
      fallback: false,
    })
    expect(processExpansionKey(done, 'collapse-when-done')).toEqual({
      key: 'process:1:0',
      fallback: false,
    })
    expect(processExpansionKey(row, 'expanded')).toEqual({
      key: 'process:1:0',
      fallback: true,
    })
    expect(processExpansionKey(row, 'collapsed')).toEqual({
      key: 'process:1:0',
      fallback: false,
    })
  })
})

describe('preparing tool calls (DSH-23)', () => {
  function preparingLog(): LogBuilder {
    const log = new LogBuilder()
    log.user('u1', 'fix it')
    log.add('turn/start', { turn: 1 })
    log.add('step/start', { turn: 1, step: 1 })
    log.chunk(1, 1, { type: 'block-start', index: 0, blockType: 'tool-call' })
    log.chunk(1, 1, {
      type: 'tool-call-delta',
      index: 0,
      id: 'c1',
      name: 'edit',
      argumentsDelta: '{"file_path":"src/pages/Login.vue","old_str',
    })
    return log
  }

  it('shows the call the model is still writing, with the parsed file name', () => {
    const log = preparingLog()
    const snapshot = snapshotOf(log.events)
    expect(describeRows(snapshot)).toEqual([
      'user',
      'process[live] steps=1: preparing:0',
    ])
    const [process] = processRows(snapshot)
    const member = process!.members[0]!
    expect(member.kind).toBe('preparing')
    const node = snapshot.nodes.get(member.key)
    expect(node?.kind).toBe('assistant')
    const data = preparingToolData(
      node as Extract<ChatNode, { kind: 'assistant' }>,
      member.kind === 'preparing' ? member.index : -1,
    )
    expect(data).toMatchObject({ callId: 'c1', name: 'edit' })
    expect(JSON.parse(data!.argsRaw)).toEqual({
      file_path: 'src/pages/Login.vue',
    })
    expect(processLiveStep(process!, snapshot.nodes)).toEqual({
      label: '准备编辑 Login.vue',
      ordinal: 1,
    })
  })

  it('hands over to the running tool row once the call is dispatched', () => {
    const log = preparingLog()
    log.chunk(1, 1, {
      type: 'tool-call-delta',
      index: 0,
      id: 'c1',
      argumentsDelta: '":"a","new_string":"b"}',
    })
    log.message(1, 1, [
      {
        type: 'tool-call',
        id: 'c1',
        name: 'edit',
        arguments:
          '{"file_path":"src/pages/Login.vue","old_string":"a","new_string":"b"}',
      },
    ])
    // Queued after the message, before dispatch: still preparing.
    expect(describeRows(snapshotOf(log.events))).toEqual([
      'user',
      'process[live] steps=1: preparing:0',
    ])
    log.call(1, 1, 'c1', 'edit', {
      file_path: 'src/pages/Login.vue',
      old_string: 'a',
      new_string: 'b',
    })
    const snapshot = stream(log.events).snapshot
    expect(describeRows(snapshot)).toEqual([
      'user',
      'process[live] steps=1: tool:edit',
    ])
    const [process] = processRows(snapshot)
    expect(processLiveStep(process!, snapshot.nodes).label).toBe(
      '正在编辑 Login.vue',
    )
  })

  it('drops preparing calls once the turn has ended', () => {
    const log = preparingLog()
    log.add('turn/end', { turn: 1, reason: { kind: 'aborted' } })
    expect(describeRows(snapshotOf(log.events)).join('\n')).not.toContain(
      'preparing',
    )
  })

  it('repairs streamed JSON arguments into the fields that are complete', () => {
    expect(partialJsonObject('{"file_path":"src/a.ts","con')).toEqual({
      file_path: 'src/a.ts',
    })
    expect(partialJsonObject('{"command":"npm run te')).toEqual({
      command: 'npm run te',
    })
    expect(partialJsonObject('{"a":1,')).toEqual({ a: 1 })
    expect(partialJsonObject('{"a":{"b":[1,2')).toEqual({ a: { b: [1, 2] } })
    expect(partialJsonObject('{"path":"a\\')).toEqual({ path: 'a' })
    expect(partialJsonObject('{"done":true}')).toEqual({ done: true })
    expect(partialJsonObject('')).toBeNull()
    expect(partialJsonObject('[1,2')).toBeNull()
  })
})

// UI-S14: the subagents a step sends out leave the process for a row of
// their own, one row per step (a group when it sent out two or more).
describe('subagent rows in the flow (UI-S14 · 1 · 3)', () => {
  /** Step 2 sends out `ids` (background) after `narration`; step 3 answers. */
  function dispatchLog(
    ids: readonly string[],
    options: { narration?: string; open?: boolean; mixed?: boolean } = {},
  ): LogBuilder {
    const log = new LogBuilder()
    log.user('u1', '写三章')
    log.add('turn/start', { turn: 1 })
    log.add('step/start', { turn: 1, step: 1 })
    log.message(1, 1, [
      { type: 'reasoning', text: '先读设定' },
      { type: 'text', text: '先读一下设定。' },
      { type: 'tool-call', id: 'r', name: 'read', arguments: '{}' },
    ])
    log.call(1, 1, 'r', 'read', { file_path: 'bible.md' })
    log.result(1, 1, 'r', 'ok')
    log.add('step/end', { turn: 1, step: 1 })
    log.add('step/start', { turn: 1, step: 2 })
    log.message(1, 2, [
      ...(options.narration === undefined
        ? []
        : [{ type: 'text', text: options.narration }]),
      ...ids.map((id) => ({
        type: 'tool-call',
        id: `call-${id}`,
        name: 'subagent',
        arguments: '{}',
      })),
      ...(options.mixed
        ? [{ type: 'tool-call', id: 'g', name: 'grep', arguments: '{}' }]
        : []),
    ])
    for (const id of ids) {
      log.call(1, 2, `call-${id}`, 'subagent', {
        description: `写 ${id}`,
        prompt: 'p',
        run_in_background: true,
      })
      log.add('subagent/started', {
        subagentId: id,
        description: `写 ${id}`,
        mode: 'spawn',
        background: true,
        callId: `call-${id}`,
      })
      log.result(1, 2, `call-${id}`, `started subagent ${id}`, {
        meta: { kind: 'continuable', subagentId: id },
      })
    }
    if (options.mixed) {
      log.call(1, 2, 'g', 'grep', { pattern: 'x' })
      log.result(1, 2, 'g', 'none')
    }
    log.add('step/end', { turn: 1, step: 2 })
    log.add('step/start', { turn: 1, step: 3 })
    if (options.open) {
      log.message(1, 3, [
        { type: 'tool-call', id: 'r2', name: 'read', arguments: '{}' },
      ])
      log.call(1, 3, 'r2', 'read', { file_path: 'ch1.md' })
      return log
    }
    log.message(1, 3, [{ type: 'text', text: '三章都在写。' }])
    log.add('step/end', { turn: 1, step: 3 })
    log.add('turn/end', { turn: 1, reason: { kind: 'completed' } })
    return log
  }

  it('gives the subagents of one step one row after the process', () => {
    const snapshot = snapshotOf(dispatchLog(['sub-a', 'sub-b', 'sub-c']).events)
    expect(describeRows(snapshot)).toEqual([
      'user',
      'process[done] steps=2: assistant tool:read',
      'agents: tool:subagent tool:subagent tool:subagent',
      'assistant(closing)',
      'turnTail',
    ])
  })

  it('shows the words of a step that only sends out subagents above them', () => {
    const snapshot = snapshotOf(
      dispatchLog(['sub-a', 'sub-b'], {
        narration: '我把设定交给两个执笔者。',
      }).events,
    )
    expect(describeRows(snapshot)).toEqual([
      'user',
      'process[done] steps=2: assistant tool:read',
      'assistant',
      'agents: tool:subagent tool:subagent',
      'assistant(closing)',
      'turnTail',
    ])
  })

  it('keeps the words in the process when the step also used other tools', () => {
    const snapshot = snapshotOf(
      dispatchLog(['sub-a'], {
        narration: '交给子智能体，再搜一下。',
        mixed: true,
      }).events,
    )
    expect(describeRows(snapshot)).toEqual([
      'user',
      'process[done] steps=2: assistant tool:read assistant',
      'agents: tool:subagent',
      'process[done] steps=1: tool:grep',
      'assistant(closing)',
      'turnTail',
    ])
  })

  it('a single subagent is a row of one; another step starts another row', () => {
    const log = dispatchLog(['sub-a'], { open: true })
    const snapshot = snapshotOf(log.events)
    expect(describeRows(snapshot)).toEqual([
      'user',
      'process[done] steps=2: assistant tool:read',
      'agents: tool:subagent',
      'process[live] steps=1: tool:read',
    ])
    // Step 3 sends out two more while its read still runs.
    for (const id of ['sub-b', 'sub-c']) {
      log.call(1, 3, `call-${id}`, 'subagent', { description: id })
      log.add('subagent/started', {
        subagentId: id,
        description: id,
        mode: 'spawn',
        background: true,
        callId: `call-${id}`,
      })
    }
    expect(describeRows(snapshotOf(log.events))).toEqual([
      'user',
      'process[done] steps=2: assistant tool:read',
      'agents: tool:subagent',
      'process[done] steps=1: tool:read',
      'agents: tool:subagent tool:subagent',
    ])
  })

  it('names the row by its first call and maps its calls for reveal', () => {
    const snapshot = snapshotOf(dispatchLog(['sub-a', 'sub-b']).events)
    const rows = timelineRowsOf(snapshot, { showSystemSteps: false })
    const agents = rows.find((row): row is AgentsRow => row.kind === 'agents')!
    expect(agents.id).toBe(`agents:${agents.members[0]}`)
    expect(agents.turn).toBe(1)
    const index = rowIndexOf(rows)
    for (const key of agents.members)
      expect(index.get(key)).toBe(rows.indexOf(agents))
    expect(rowNodeKey(agents)).toBe(agents.members[0])
  })
})

describe('chat durations', () => {
  it('reads like 已处理 9 步 · 用时 1 分 12 秒', () => {
    expect(formatRunDuration(8_000)).toBe('8 秒')
    expect(formatRunDuration(72_000)).toBe('1 分 12 秒')
    expect(formatRunDuration(60_000)).toBe('1 分')
    expect(formatRunDuration(3_720_000)).toBe('1 小时 2 分')
  })
})
