import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Tool } from '../tools/base'
import { ToolRegistry } from '../tools/registry'
import { toolParamsSchema } from '../tools/schema'
import { MessageBus } from './bus'
import * as teamEvents from './events'
import { TeamManager, roleToAgentType } from './manager'
import {
  LEAD_ACTOR,
  TeamMember,
  TeamMessage,
  TeamStatus,
  validateActorName,
  validateMemberName,
} from './models'
import { TeamStore } from './store'
import { teamThreadRevision } from './store'
import {
  TeamBroadcastTool,
  TeamListTool,
  TeamReadInboxTool,
  TeamSendMessageTool,
  TeamShutdownTool,
  TeamSpawnTool,
} from './tools'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

class EchoTool extends Tool {
  override name = 'echo'
  override description = 'echo'
  override parameters = toolParamsSchema({})
  override readOnly = true
  execute(): string {
    return 'echo'
  }
}

function fakeSubagents() {
  const specs = new Map<string, { name: string; tool_names: string[] }>([
    ['sili_suitang', { name: 'sili_suitang', tool_names: ['echo'] }],
    ['neiguan_yingzao', { name: 'neiguan_yingzao', tool_names: ['echo'] }],
  ])
  return {
    get: (name: string) => specs.get(name) ?? null,
    resolveName: (name: string) => specs.get(name)?.name ?? name,
    names: () => [...specs.keys()],
  }
}

describe('team models/events', () => {
  it('validates names, normalizes members/messages, and creates event payloads', () => {
    expect(validateMemberName('alice-1')).toBe('alice-1')
    expect(() => validateMemberName('lead')).toThrow(/reserved/)
    expect(validateActorName(LEAD_ACTOR)).toBe(LEAD_ACTOR)
    const member = TeamMember.fromDict({
      name: 'alice',
      role: 'reader',
      agentType: 'sili_suitang',
      status: 'bogus',
    })
    expect(member.status).toBe(TeamStatus.IDLE)
    const msg = TeamMessage.create({
      from_actor: 'lead',
      to: 'alice',
      content: 'hi',
      type: 'task',
    })
    expect(TeamMessage.fromDict(msg.toDict()).toDict()).toEqual(msg.toDict())
    expect(teamEvents.memberUpdate(member)).toMatchObject({
      event: 'team_member_update',
      member: { name: 'alice' },
    })
    expect(teamEvents.messageEvent(msg)).toMatchObject({
      event: 'team_message',
      message: { to: 'alice' },
    })
    expect(
      teamEvents.runStart({ parent_id: 'p', member, purpose: 'work' }),
    ).toMatchObject({ event: 'team_run_start', teammate: 'alice' })
  })
})

describe('TeamStore and MessageBus', () => {
  it('persists roster, threads, checkpoints, cursors, and marks stale working offline', () => {
    const root = tmp('emperor-team-store-')
    const store = new TeamStore(root)
    const member = new TeamMember({
      name: 'alice',
      role: 'reader',
      agent_type: 'sili_suitang',
      status: TeamStatus.WORKING,
    })
    store.upsertMember(member)
    const reopened = new TeamStore(root)
    expect(reopened.getMember('alice')?.status).toBe(TeamStatus.OFFLINE)

    reopened.writeThread('alice', [{ role: 'assistant', content: 'done' }])
    reopened.writeCheckpoint('alice', [{ role: 'user', content: 'pending' }], {
      pending_cursor_start: 1,
      pending_cursor_end: 2,
      pending_message_ids: ['m1'],
    })
    reopened.writeCursor('alice', 3)
    expect(reopened.readThread('alice')).toHaveLength(1)
    expect(
      reopened.readCheckpointPayload('alice')?.pending_message_ids,
    ).toEqual(['m1'])
    expect(reopened.readCursor('alice')).toBe(3)
    expect(existsSync(join(root, '.team', 'threads', 'alice.json'))).toBe(true)
  })

  it('isolates a corrupt config.json instead of silently discarding it (audit P1-5)', () => {
    const root = tmp('emperor-team-corrupt-')
    const store = new TeamStore(root)
    store.upsertMember(
      new TeamMember({
        name: 'alice',
        role: 'reader',
        agent_type: 'sili_suitang',
      }),
    )
    writeFileSync(store.configFile, '{ not json', 'utf8')

    const reloaded = new TeamStore(root)
    expect(reloaded.loadConfig().members).toEqual([])

    const files = readdirSync(join(root, '.team'))
    expect(files.some((f) => f.startsWith('config.json.corrupt-'))).toBe(true)
  })

  it('appends inbox messages, reads unread by cursor, and skips corrupt lines', () => {
    const store = new TeamStore(tmp('emperor-team-bus-'))
    const bus = new MessageBus(store)
    bus.send({ from_actor: 'lead', to: 'alice', content: 'one' })
    bus.send({ from_actor: 'lead', to: 'alice', content: 'two' })
    expect(bus.unreadCount('alice')).toBe(2)
    expect(bus.read('alice', { limit: 1 }).map((m) => m.content)).toEqual([
      'one',
    ])
    expect(bus.unreadCount('alice')).toBe(1)
    expect(
      bus.read('alice', { limit: 0, mark_read: false }).map((m) => m.content),
    ).toEqual(['two'])
    expect(bus.unreadCount('alice')).toBe(1)
  })

  it('rotates the read prefix of an inbox once it grows past the hot threshold, without losing unread messages (audit P1-4)', () => {
    const root = tmp('emperor-team-bus-rotate-')
    const store = new TeamStore(root)
    const bus = new MessageBus(store)
    const total = 5200
    for (let i = 0; i < total; i++)
      bus.send({ from_actor: 'lead', to: 'alice', content: `msg-${i}` })

    // 读完前面大部分消息，留 100 条未读——只有"已读"前缀允许被归档。
    bus.read('alice', { limit: total - 100 })
    expect(bus.unreadCount('alice')).toBe(100)

    // 热文件不应该无限增长——已读前缀超过阈值后应轮转到归档，热文件只保留最近一批已读 + 全部未读。
    const hotLines = readFileSync(store.inboxPath('alice'), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
    expect(hotLines.length).toBeLessThan(total)

    // 轮转绝不能影响未读计数或未读内容——只归档已读前缀。
    expect(bus.unreadCount('alice')).toBe(100)
    expect(bus.recent('alice', { limit: 100 }).map((m) => m.content)).toEqual(
      Array.from({ length: 100 }, (_, i) => `msg-${total - 100 + i}`),
    )

    // 被归档的消息仍然落盘可查，不是直接丢弃。
    const archiveDir = join(root, '.team', 'inbox', 'archive')
    expect(existsSync(archiveDir)).toBe(true)
    expect(readdirSync(archiveDir).some((f) => f.startsWith('alice'))).toBe(
      true,
    )
  })
})

describe('TeamManager and tools', () => {
  it('resumes a prepared checkpoint without duplicating the pending inbox turn', async () => {
    const root = tmp('emperor-team-checkpoint-prepared-')
    const store = new TeamStore(root)
    store.upsertMember(
      new TeamMember({
        name: 'alice',
        role: 'reader',
        agent_type: 'sili_suitang',
      }),
    )
    const bus = new MessageBus(store)
    const pending = bus.send({
      from_actor: LEAD_ACTOR,
      to: 'alice',
      content: 'original inbox task',
      type: 'task',
    })
    const preparedHistory = [
      { role: 'system', content: 'durable prepared marker' },
      { role: 'user', content: 'prepared inbox rendering' },
    ]
    store.writeCheckpoint('alice', preparedHistory, {
      checkpoint_version: 2,
      turn_id: 'turn_prepared',
      phase: 'prepared',
      base_thread_revision: teamThreadRevision([]),
      pending_cursor_start: 0,
      pending_cursor_end: 1,
      pending_message_ids: [pending.id],
    })

    const histories: Array<Array<Record<string, unknown>>> = []
    const manager = new TeamManager({
      root,
      subagentRegistry: fakeSubagents(),
      runnerFactory: () => ({
        step: (history) => {
          histories.push(structuredClone(history))
          return 'prepared resumed'
        },
      }),
    })

    expect(await manager.wakeTeammate('alice')).toBe('prepared resumed')
    expect(histories).toEqual([preparedHistory])
    expect(manager.store.readCursor('alice')).toBe(1)
    expect(manager.store.readCheckpointPayload('alice')).toBeNull()
  })

  it('fails closed when a checkpoint file exists but cannot be decoded', async () => {
    const root = tmp('emperor-team-checkpoint-corrupt-')
    const store = new TeamStore(root)
    store.upsertMember(
      new TeamMember({
        name: 'alice',
        role: 'reader',
        agent_type: 'sili_suitang',
      }),
    )
    const bus = new MessageBus(store)
    bus.send({ from_actor: LEAD_ACTOR, to: 'alice', content: 'do not replay' })
    writeFileSync(store.checkpointPath('alice'), '{broken checkpoint', 'utf8')
    let calls = 0
    const manager = new TeamManager({
      root,
      subagentRegistry: fakeSubagents(),
      runnerFactory: () => ({
        step: () => {
          calls += 1
          return 'unsafe replay'
        },
      }),
    })

    expect(await manager.wakeTeammate('alice')).toMatch(
      /checkpoint.*corrupt|cannot be decoded/i,
    )
    expect(calls).toBe(0)
    expect(manager.store.readCursor('alice')).toBe(0)
    expect(existsSync(manager.store.checkpointPath('alice'))).toBe(true)
  })

  it('rejects a prepared checkpoint when its durable thread revision diverges', async () => {
    const root = tmp('emperor-team-checkpoint-revision-')
    const store = new TeamStore(root)
    store.upsertMember(
      new TeamMember({
        name: 'alice',
        role: 'reader',
        agent_type: 'sili_suitang',
      }),
    )
    const bus = new MessageBus(store)
    const pending = bus.send({
      from_actor: LEAD_ACTOR,
      to: 'alice',
      content: 'revision guarded task',
    })
    store.writeCheckpoint('alice', [{ role: 'user', content: 'prepared' }], {
      checkpoint_version: 2,
      turn_id: 'turn_revision',
      phase: 'prepared',
      base_thread_revision: teamThreadRevision([]),
      pending_cursor_start: 0,
      pending_cursor_end: 1,
      pending_message_ids: [pending.id],
    })
    store.writeThread('alice', [{ role: 'assistant', content: 'diverged' }])
    let calls = 0
    const manager = new TeamManager({
      root,
      subagentRegistry: fakeSubagents(),
      runnerFactory: () => ({
        step: () => {
          calls += 1
          return 'must not run'
        },
      }),
    })

    expect(await manager.wakeTeammate('alice')).toMatch(/revision diverged/i)
    expect(calls).toBe(0)
    expect(manager.store.readCursor('alice')).toBe(0)
  })

  it('fails closed for an ambiguous running checkpoint until retry is explicit', async () => {
    const root = tmp('emperor-team-checkpoint-running-')
    const store = new TeamStore(root)
    store.upsertMember(
      new TeamMember({
        name: 'alice',
        role: 'reader',
        agent_type: 'sili_suitang',
      }),
    )
    const bus = new MessageBus(store)
    const pending = bus.send({
      from_actor: LEAD_ACTOR,
      to: 'alice',
      content: 'may have caused an external effect',
    })
    const runningHistory = [{ role: 'user', content: 'running turn' }]
    store.writeCheckpoint('alice', runningHistory, {
      checkpoint_version: 2,
      turn_id: 'turn_running',
      phase: 'running',
      base_thread_revision: teamThreadRevision([]),
      pending_cursor_start: 0,
      pending_cursor_end: 1,
      pending_message_ids: [pending.id],
    })

    let calls = 0
    const manager = new TeamManager({
      root,
      subagentRegistry: fakeSubagents(),
      runnerFactory: () => ({
        step: () => {
          calls += 1
          return 'explicit retry completed'
        },
      }),
    })

    expect(await manager.wakeTeammate('alice')).toMatch(
      /ambiguous.*recovery.*retry/i,
    )
    expect(calls).toBe(0)
    expect(manager.store.readCursor('alice')).toBe(0)
    expect(manager.store.readCheckpointPayload('alice')?.phase).toBe('running')

    expect(await manager.wakeTeammate('alice', { recovery: 'retry' })).toBe(
      'explicit retry completed',
    )
    expect(calls).toBe(1)
    expect(manager.store.readCursor('alice')).toBe(1)
  })

  it('finalizes a completed checkpoint without rerunning or duplicating its lead receipt', async () => {
    const root = tmp('emperor-team-checkpoint-terminal-')
    const store = new TeamStore(root)
    store.upsertMember(
      new TeamMember({
        name: 'alice',
        role: 'reader',
        agent_type: 'sili_suitang',
      }),
    )
    const bus = new MessageBus(store)
    const pending = bus.send({
      from_actor: LEAD_ACTOR,
      to: 'alice',
      content: 'finish this once',
    })
    const finalHistory = [{ role: 'user', content: 'completed turn' }]
    store.writeCheckpoint('alice', finalHistory, {
      checkpoint_version: 2,
      turn_id: 'turn_terminal',
      phase: 'terminal_pending',
      base_thread_revision: teamThreadRevision([]),
      final_thread_revision: teamThreadRevision(finalHistory),
      pending_cursor_start: 0,
      pending_cursor_end: 1,
      pending_message_ids: [pending.id],
      last_effect_receipt: {
        kind: 'runner_result',
        result: 'durable completed result',
        reply_required: true,
        reply_message_id: null,
      },
    })
    bus.send({
      from_actor: 'alice',
      to: LEAD_ACTOR,
      content: 'durable completed result',
      type: 'result',
      in_reply_to: pending.id,
      meta: { team_turn_id: 'turn_terminal' },
    })

    let calls = 0
    const manager = new TeamManager({
      root,
      subagentRegistry: fakeSubagents(),
      runnerFactory: () => ({
        step: () => {
          calls += 1
          return 'must not run'
        },
      }),
    })

    expect(await manager.wakeTeammate('alice')).toBe('durable completed result')
    expect(calls).toBe(0)
    expect(manager.store.readCursor('alice')).toBe(1)
    expect(manager.store.readThread('alice')).toEqual(finalHistory)
    expect(
      manager.bus
        .allMessages(LEAD_ACTOR)
        .filter((message) => message.meta.team_turn_id === 'turn_terminal'),
    ).toHaveLength(1)
    expect(manager.store.readCheckpointPayload('alice')).toBeNull()
  })

  it('rejects a terminal checkpoint with a malformed effect receipt', async () => {
    const root = tmp('emperor-team-checkpoint-receipt-')
    const store = new TeamStore(root)
    store.upsertMember(
      new TeamMember({
        name: 'alice',
        role: 'reader',
        agent_type: 'sili_suitang',
      }),
    )
    const bus = new MessageBus(store)
    const pending = bus.send({
      from_actor: LEAD_ACTOR,
      to: 'alice',
      content: 'receipt guarded task',
    })
    const finalHistory = [{ role: 'user', content: 'completed' }]
    writeFileSync(
      store.checkpointPath('alice'),
      JSON.stringify({
        version: 1,
        member: 'alice',
        messages: finalHistory,
        checkpoint_version: 2,
        turn_id: 'turn_bad_receipt',
        phase: 'terminal_pending',
        base_thread_revision: teamThreadRevision([]),
        final_thread_revision: teamThreadRevision(finalHistory),
        pending_cursor_start: 0,
        pending_cursor_end: 1,
        pending_message_ids: [pending.id],
        last_effect_receipt: {
          kind: 'runner_result',
          result: 'must not be accepted',
          reply_required: 'yes',
          reply_message_id: null,
        },
      }),
      'utf8',
    )
    let calls = 0
    const manager = new TeamManager({
      root,
      subagentRegistry: fakeSubagents(),
      runnerFactory: () => ({
        step: () => {
          calls += 1
          return 'must not run'
        },
      }),
    })

    expect(await manager.wakeTeammate('alice')).toMatch(
      /missing.*effect receipt|invalid.*effect receipt/i,
    )
    expect(calls).toBe(0)
    expect(manager.store.readCursor('alice')).toBe(0)
  })

  it('never lets a late runner result overwrite a shutdown member state', async () => {
    const root = tmp('emperor-team-late-terminal-')
    let releaseRunner!: (result: string) => void
    let signalStarted!: () => void
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve
    })
    const runnerResult = new Promise<string>((resolve) => {
      releaseRunner = resolve
    })
    const manager = new TeamManager({
      root,
      subagentRegistry: fakeSubagents(),
      runnerFactory: () => ({
        step: async () => {
          signalStarted()
          return runnerResult
        },
      }),
    })
    await manager.spawnTeammate({ name: 'alice', role: 'reader' })
    const wake = manager.sendMessage({
      to: 'alice',
      content: 'long running task',
      wake: true,
    })
    await started
    await manager.shutdownTeammate({ name: 'alice' })
    releaseRunner('late completed result')
    await wake

    expect(manager.store.getMember('alice')?.status).toBe(TeamStatus.SHUTDOWN)
  })

  it('spawns teammates, wakes on messages, writes lead replies, and exposes payloads', async () => {
    const root = tmp('emperor-team-manager-')
    const parentRegistry = new ToolRegistry()
    parentRegistry.register(new EchoTool())
    const emitted: Array<Record<string, unknown>> = []
    const manager = new TeamManager({
      root,
      parentRegistry,
      subagentRegistry: fakeSubagents(),
      runnerFactory: ({ member }) => ({
        step: (history: Array<Record<string, unknown>>) =>
          `handled by ${member.name}: ${String(history.at(-1)?.content ?? '').slice(0, 20)}`,
      }),
      eventSink: async (event) => {
        emitted.push(event)
      },
    })

    expect(roleToAgentType('coder')).toBe('neiguan_yingzao')
    const created = JSON.parse(
      await manager.spawnTeammate({
        name: 'alice',
        role: 'reader',
        task: 'read docs',
      }),
    )
    expect(created.created.name).toBe('alice')
    expect(manager.store.getMember('alice')?.status).toBe(TeamStatus.IDLE)
    expect(manager.bus.unreadCount(LEAD_ACTOR)).toBe(1)
    expect(manager.payload().members).toHaveLength(1)
    expect(emitted.map((e) => e.event)).toContain('team_run_start')

    const sent = JSON.parse(
      await manager.sendMessage({
        to: 'alice',
        content: 'next task',
        wake: true,
      }),
    )
    expect(sent.result).toContain('handled by alice')
    expect(manager.store.readThread('alice').at(-1)?.role).toBe('user')
    expect(manager.readInbox({ actor: LEAD_ACTOR })).toContain(
      'handled by alice',
    )
  })

  it('team tools delegate to the manager with lead/teammate wake boundaries', async () => {
    const root = tmp('emperor-team-tools-')
    const manager = new TeamManager({
      root,
      subagentRegistry: fakeSubagents(),
      runnerFactory: ({ member }) => ({ step: () => `ok ${member.name}` }),
    })
    const spawn = new TeamSpawnTool(manager)
    await spawn.execute({ name: 'bob', role: 'reader' })
    expect(await new TeamListTool(manager).execute({})).toContain('bob')
    expect(
      await new TeamSendMessageTool(manager).execute({
        to: 'bob',
        content: 'hi',
        wake: true,
      }),
    ).toContain('ok bob')
    expect(
      await new TeamBroadcastTool(manager).execute({
        content: 'all',
        wake: false,
      }),
    ).toContain('"sent"')
    expect(
      await new TeamReadInboxTool(manager).execute({
        limit: 10,
        mark_read: false,
      }),
    ).toContain('ok bob')
    expect(
      await new TeamShutdownTool(manager).execute({ name: 'bob' }),
    ).toContain('"shutdown"')

    const teammateSend = new TeamSendMessageTool(manager, {
      sender: 'bob',
      allowWake: false,
    })
    const result = await teammateSend.execute({
      to: LEAD_ACTOR,
      content: 'report',
      wake: true,
    })
    expect(result).toContain('"result":null')
    expect(
      readFileSync(join(root, '.team', 'inbox', 'lead.jsonl'), 'utf8'),
    ).toContain('report')
  })

  it('routes team tool runtime events through the current tool context emitter', async () => {
    const root = tmp('emperor-team-tools-scoped-events-')
    const defaultEvents: Array<Record<string, unknown>> = []
    const scopedEvents: Array<Record<string, unknown>> = []
    const manager = new TeamManager({
      root,
      subagentRegistry: fakeSubagents(),
      runnerFactory: ({ member }) => ({ step: () => `ok ${member.name}` }),
      eventSink: async (event) => {
        defaultEvents.push(event)
      },
    })
    const spawn = new TeamSpawnTool(manager)

    await spawn.execute(
      { name: 'scoped', role: 'reader', task: '' },
      {
        root,
        workspaceRoot: root,
        arguments: {},
        emit: async (event) => {
          scopedEvents.push(event)
        },
      },
    )

    expect(scopedEvents.map((event) => event.event)).toContain(
      'team_member_update',
    )
    expect(defaultEvents.map((event) => event.event)).not.toContain(
      'team_member_update',
    )
  })
})
