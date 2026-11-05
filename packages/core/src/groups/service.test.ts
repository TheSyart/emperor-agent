// GRP-06: a group is its own session (surface 'group') whose log holds the
// group events; each member speaks in a session of its own (surface
// 'group_member'). The store creates both, folds the log and turns the
// user's five ways of sending into envelopes plus the speaking plan.
import { describe, expect, it } from 'vitest'
import { pendingDelivery } from './delivery'
import { digestSource } from './digest'
import { foldGroupEvents } from './events'
import {
  GroupError,
  GroupService,
  type GroupContact,
  type GroupLog,
  type GroupServiceDeps,
  type GroupSessionEntry,
} from './service'

function fixture(
  contacts: GroupContact[] = CONTACTS,
  extra: Pick<GroupServiceDeps, 'defaults'> = {},
) {
  const sessions = new Map<string, GroupSessionEntry>()
  const logs = new Map<string, { type: string; data: unknown }[]>()
  const changes: unknown[] = []
  const trashedGroups: string[] = []
  let n = 0
  const service = new GroupService({
    sessions: {
      create: (title, opts) => {
        const id = opts.id ?? `s${++n}`
        const entry: GroupSessionEntry = {
          id,
          title,
          surface: opts.surface,
          ...(opts.contactId ? { contact_id: opts.contactId } : {}),
          ...(opts.groupId ? { group_id: opts.groupId } : {}),
        }
        sessions.set(id, entry)
        return entry
      },
      get: (id) => sessions.get(id) ?? null,
      list: () => [...sessions.values()],
      rename: (id, title) => {
        const entry = sessions.get(id)
        if (!entry) return false
        entry.title = title
        return true
      },
      trashGroup: (groupId) => {
        trashedGroups.push(groupId)
        for (const [id, entry] of sessions)
          if (id === groupId || entry.group_id === groupId) sessions.delete(id)
        return { restorableUntil: '2026-11-27T00:00:00.000Z' }
      },
    },
    log: (id): GroupLog => {
      const events = logs.get(id) ?? []
      logs.set(id, events)
      return {
        events,
        append: (type, data) => void events.push({ type, data }),
      }
    },
    contact: (id) => contacts.find((c) => c.id === id) ?? null,
    newId: (prefix) => `${prefix}${++n}`,
    now: () => 1_700_000_000_000 + n,
    onChange: (change) => changes.push(change),
    ...extra,
  })
  return { service, sessions, logs, changes, trashedGroups }
}

const CONTACTS: GroupContact[] = [
  {
    id: 'ct-emperor',
    name: 'Emperor',
    intro: '主持人',
    kind: 'local',
    speak: 'relevant',
    version: 1,
  },
  {
    id: 'ct-arch',
    name: '架构师',
    intro: '系统设计',
    kind: 'local',
    speak: 'relevant',
    version: 3,
  },
  {
    id: 'ct-rev',
    name: '审稿人',
    intro: '评审',
    kind: 'local',
    speak: 'relevant',
    version: 2,
  },
  {
    id: 'ct-codex',
    name: 'Codex',
    intro: '外部',
    kind: 'external',
    speak: 'mentioned',
    version: 1,
  },
]

function group(f = fixture()) {
  const view = f.service.create({
    title: '登录页改版',
    members: ['ct-emperor', 'ct-arch', 'ct-rev'],
    settings: { coordination: 'member' },
  })
  return { ...f, view }
}

describe('GroupService.create', () => {
  it('makes the group session, one session per member, and logs it', () => {
    const { view, sessions, logs } = group()
    const entry = sessions.get(view.id)!
    expect(entry).toMatchObject({
      title: '登录页改版',
      surface: 'group',
      group_id: view.id,
    })
    const memberSessions = [...sessions.values()].filter(
      (s) => s.surface === 'group_member',
    )
    expect(memberSessions.map((s) => s.contact_id)).toEqual([
      'ct-emperor',
      'ct-arch',
      'ct-rev',
    ])
    expect(memberSessions.every((s) => s.group_id === view.id)).toBe(true)
    const types = logs.get(view.id)!.map((e) => e.type)
    expect(types[0]).toBe('group/created')
    expect(types.filter((t) => t === 'group/member')).toHaveLength(3)
  })

  it('makes Emperor the moderator when it is a member, autonomous by default', () => {
    const { view } = group()
    expect(view.moderator).toBe('ct-emperor')
    expect(view.settings).toEqual({
      collaboration: 'autonomous',
      coordination: 'member',
      quiet: false,
      summarizeAtEnd: true,
      loopGuard: true,
    })
    expect(view.members.map((m) => [m.id, m.memberSessionId !== null])).toEqual(
      [
        ['ct-emperor', true],
        ['ct-arch', true],
        ['ct-rev', true],
      ],
    )
  })

  it('has no moderator without Emperor unless one is named', () => {
    const f = fixture()
    expect(
      f.service.create({ title: 'g', members: ['ct-arch', 'ct-rev'] })
        .moderator,
    ).toBeNull()
    expect(
      f.service.create({
        title: 'g2',
        members: ['ct-arch', 'ct-rev'],
        moderator: 'ct-rev',
        settings: { coordination: 'member' },
      }).moderator,
    ).toBe('ct-rev')
  })

  it('always keeps exactly one visible Emperor, including in existing groups', () => {
    const f = fixture()
    const view = f.service.create({ title: '默认协调', members: ['ct-arch'] })
    expect(view.members.map((member) => member.id)).toEqual([
      'ct-emperor',
      'ct-arch',
    ])
    expect(() => f.service.removeMember(view.id, 'ct-emperor')).toThrow(
      'Emperor 是群聊的固定成员',
    )
    expect(f.service.leaveAll('ct-emperor')).toEqual([])
    const deduplicated = f.service.create({
      title: '不重复',
      members: ['ct-emperor', 'ct-rev', 'ct-emperor'],
    })
    expect(
      deduplicated.members.filter((member) => member.id === 'ct-emperor'),
    ).toHaveLength(1)

    f.service.append(view.id, 'group/member', {
      action: 'removed',
      contactId: 'ct-emperor',
      contactVersion: 1,
    })
    expect(f.service.get(view.id).members.map((member) => member.id)).toEqual([
      'ct-arch',
    ])
    expect(f.service.migrateLegacyCoordination()).toBe(1)
    expect(f.service.get(view.id).members.map((member) => member.id)).toEqual([
      'ct-arch',
      'ct-emperor',
    ])
    expect(f.service.migrateLegacyCoordination()).toBe(0)
  })

  it('migrates a legacy group before the contact directory has loaded Emperor', () => {
    const f = fixture(CONTACTS.filter((contact) => contact.id !== 'ct-emperor'))
    const view = f.service.create({
      title: '旧群',
      members: ['ct-arch'],
      settings: { coordination: 'member' },
    })
    f.service.append(view.id, 'group/member', {
      action: 'removed',
      contactId: 'ct-emperor',
      contactVersion: 1,
    })

    expect(f.service.migrateLegacyCoordination()).toBe(1)
    expect(f.service.get(view.id).members).toContainEqual({
      id: 'ct-emperor',
      name: 'Emperor',
      intro: '你的主智能体：统筹、拆解任务，在群里主持讨论',
      external: false,
      speak: 'relevant',
      memberSessionId: expect.any(String),
      missing: false,
    })
  })

  it('refuses an unknown contact, a repeated member or an outside moderator', () => {
    const f = fixture()
    expect(() =>
      f.service.create({ title: 'g', members: ['ct-arch', 'ct-ghost'] }),
    ).toThrow(GroupError)
    expect(() =>
      f.service.create({ title: 'g', members: ['ct-arch', 'ct-arch'] }),
    ).toThrow(/重复/)
    expect(
      f.service.create({ title: 'g', members: [] }).members.map((m) => m.id),
    ).toEqual(['ct-emperor'])
    expect(() =>
      f.service.create({
        title: 'g',
        members: ['ct-arch'],
        moderator: 'ct-rev',
        settings: { coordination: 'member' },
      }),
    ).toThrow(/主持人/)
  })

  it('keeps non-collaboration preferences while legacy moderation stays autonomous', () => {
    const f = fixture()
    const view = f.service.create({
      title: 'g',
      members: ['ct-arch'],
      settings: { collaboration: 'moderated', quiet: true },
    })
    expect(view.settings).toMatchObject({
      collaboration: 'autonomous',
      quiet: true,
    })
  })
})

describe('GroupService.send', () => {
  it('logs the envelope of each way of sending and returns the plan', () => {
    const { service, view, logs } = group()
    const broadcast = service.send(view.id, {
      way: 'broadcast',
      text: '大家看看方案',
    })
    expect(broadcast.message).toMatchObject({
      from: 'user',
      audience: { kind: 'all' },
      ask: [],
    })
    expect(broadcast.plan[0]).toMatchObject({ kind: 'poll' })
    const mention = service.send(view.id, {
      way: 'mention',
      text: '@审稿人 你先看',
    })
    expect(mention.message.ask).toEqual(['ct-rev'])
    expect(mention.plan).toEqual([
      {
        kind: 'speak',
        member: 'ct-rev',
        reason: 'asked',
        source: mention.message.id,
      },
    ])
    const dm = service.send(view.id, {
      way: 'private',
      to: 'ct-arch',
      text: '私下问一句',
    })
    expect(dm.message.audience).toEqual({ kind: 'private', to: 'ct-arch' })
    const messages = logs
      .get(view.id)!
      .filter((e) => e.type === 'group/message')
    expect(
      messages.map((event) => (event.data as { text: string }).text),
    ).toEqual([
      '大家看看方案',
      '@审稿人 你先看',
      '已请审稿人回答。',
      '私下问一句',
      '已请架构师回答。',
    ])
  })

  it('refuses a private message to someone outside the group', () => {
    const { service, view } = group()
    expect(() =>
      service.send(view.id, { way: 'private', to: 'ct-codex', text: 'hi' }),
    ).toThrow(GroupError)
  })

  it('refuses empty text and an unknown group', () => {
    const { service, view } = group()
    expect(() =>
      service.send(view.id, { way: 'broadcast', text: '  ' }),
    ).toThrow(/内容/)
    expect(() =>
      service.send('nope', { way: 'broadcast', text: 'hi' }),
    ).toThrow(/没有这个群/)
  })
})

describe('GroupService members and settings', () => {
  it('adds a member with its own session and removes one, keeping history', () => {
    const { service, view, sessions } = group()
    const added = service.addMember(view.id, 'ct-codex')
    expect(added.members.map((m) => m.id)).toContain('ct-codex')
    const codex = added.members.find((m) => m.id === 'ct-codex')!
    expect(sessions.get(codex.memberSessionId!)).toMatchObject({
      surface: 'group_member',
      contact_id: 'ct-codex',
    })
    expect(() => service.addMember(view.id, 'ct-codex')).toThrow(/已经在群里/)
    service.send(view.id, { way: 'broadcast', text: 'hi' })
    const removed = service.removeMember(view.id, 'ct-arch')
    expect(removed.members.map((m) => m.id)).not.toContain('ct-arch')
    expect(service.history(view.id).messages).toHaveLength(1)
    expect(() => service.removeMember(view.id, 'ct-arch')).toThrow(/不在群里/)
  })

  it('clears a legacy moderator without removing the fixed Emperor member', () => {
    const { service, view } = group()
    expect(service.update(view.id, { moderator: null }).moderator).toBeNull()
    expect(service.get(view.id).members.map((m) => m.id)).toContain(
      'ct-emperor',
    )
  })

  it('updates title, charter, moderator and settings, and renames the session', () => {
    const { service, view, sessions } = group()
    const next = service.update(view.id, {
      title: '登录页 v2',
      charter: '两周内上线',
      moderator: 'ct-arch',
      settings: { quiet: true },
    })
    expect(next).toMatchObject({
      title: '登录页 v2',
      charter: '两周内上线',
      moderator: 'ct-arch',
    })
    expect(next.settings.quiet).toBe(true)
    expect(sessions.get(view.id)!.title).toBe('登录页 v2')
    expect(() => service.update(view.id, { moderator: 'ct-codex' })).toThrow(
      /主持人/,
    )
  })
})

describe('GroupService.history and list', () => {
  it('shows the user every message, marking private ones and hidden answers', () => {
    const { service, view } = group()
    service.send(view.id, { way: 'private', to: 'ct-arch', text: '私信' })
    service.send(view.id, {
      way: 'independent',
      ask: ['ct-arch', 'ct-rev'],
      text: '各自估个工期',
    })
    const { messages } = service.history(view.id)
    expect(messages.map((m) => [m.text, m.private, m.hidden])).toEqual([
      ['私信', true, false],
      ['已请架构师回答。', false, false],
      ['各自估个工期', false, true],
      ['已请架构师、审稿人分别作答，完成后一起显示。', false, false],
    ])
  })

  it('pages backwards from a message', () => {
    const { service, view } = group()
    for (const text of ['一', '二', '三', '四'])
      service.send(view.id, { way: 'broadcast', text })
    const last = service.history(view.id, { limit: 2 })
    expect(last.messages.map((m) => m.text)).toEqual(['三', '四'])
    expect(last.more).toBe(true)
    const before = service.history(view.id, {
      limit: 2,
      before: last.messages[0]!.id,
    })
    expect(before.messages.map((m) => m.text)).toEqual(['一', '二'])
    expect(before.more).toBe(false)
  })

  it('lists the groups with their member counts', () => {
    const f = fixture()
    f.service.create({ title: '甲', members: ['ct-arch'] })
    f.service.create({ title: '乙', members: ['ct-arch', 'ct-rev'] })
    expect(f.service.list().map((g) => [g.title, g.memberCount])).toEqual([
      ['甲', 2],
      ['乙', 3],
    ])
  })

  it('counts the groups a contact is in and what it said there (GRP-05 profile)', () => {
    const f = fixture()
    const first = f.service.create({
      title: '甲',
      members: ['ct-arch', 'ct-rev'],
    }).id
    const second = f.service.create({ title: '乙', members: ['ct-rev'] }).id
    const left = f.service.create({ title: '丙', members: ['ct-rev'] }).id
    f.service.create({ title: '丁', members: ['ct-arch'] })
    const say = (
      groupId: string,
      from: string,
      kind: 'say' | 'pass' | 'summary' | 'system',
      text: string,
    ) =>
      f.service.append(groupId, 'group/message', {
        id: `gm_${text}`,
        turnId: 't1',
        from,
        audience: { kind: 'all' },
        ask: [],
        answerMode: 'relay',
        kind,
        text,
        at: 1,
      })
    say(first, 'ct-rev', 'say', '一')
    say(first, 'ct-rev', 'pass', '没有补充')
    say(first, 'ct-arch', 'say', '二')
    say(second, 'ct-rev', 'summary', '三')
    say(second, 'system', 'system', '四')
    say(left, 'ct-rev', 'say', '五')
    f.service.removeMember(left, 'ct-rev')
    // A group it left is not counted; what it said there still is.
    expect(f.service.activity('ct-rev')).toEqual({ groups: 2, speeches: 3 })
    expect(f.service.activity('ct-arch')).toEqual({ groups: 2, speeches: 1 })
    expect(f.service.activity('ct-codex')).toEqual({ groups: 0, speeches: 0 })
  })

  it('announces every change', () => {
    const { service, view, changes } = group()
    service.send(view.id, { way: 'broadcast', text: 'hi' })
    expect(changes).toEqual([
      { reason: 'created', groupId: view.id },
      { reason: 'message', groupId: view.id },
    ])
  })
})

// GRP-08: what the group page reads besides the messages — the turn on
// screen, each task's latest state, 设置 › 群聊's defaults for a new group,
// and a change event whenever the view of a message changes.
describe('GroupService for the group page (GRP-08)', () => {
  it('CG-01: always uses autonomous collaboration, including legacy defaults and explicit legacy input', () => {
    let defaults: ReturnType<NonNullable<GroupServiceDeps['defaults']>> = {}
    const { service } = fixture(CONTACTS, { defaults: () => defaults })
    const before = service.create({ title: '旧群', members: ['ct-arch'] })
    defaults = { collaboration: 'moderated', loopGuard: false }
    const after = service.create({ title: '新群', members: ['ct-arch'] })
    expect(after.settings).toMatchObject({
      collaboration: 'autonomous',
      loopGuard: false,
    })
    expect(service.get(before.id).settings).toMatchObject({
      collaboration: 'autonomous',
      loopGuard: true,
    })
    // Legacy callers cannot turn moderation back on.
    const picked = service.create({
      title: '旧调用',
      members: ['ct-arch'],
      settings: { collaboration: 'moderated' },
    })
    expect(picked.settings.collaboration).toBe('autonomous')
  })

  it('shows the latest turn with when it started', () => {
    const { service, view } = group()
    expect(service.get(view.id).turn).toBeNull()
    const { message } = service.send(view.id, { way: 'broadcast', text: 'hi' })
    service.append(view.id, 'group/turn', {
      turnId: message.turnId,
      state: 'started',
      spend: { usd: 0, tokens: 0 },
    })
    expect(service.get(view.id).turn).toEqual({
      turnId: message.turnId,
      state: 'started',
      spend: { usd: 0, tokens: 0 },
      startedAt: message.at,
      speakers: [],
      queued: [],
    })
    service.append(view.id, 'group/turn', {
      turnId: message.turnId,
      state: 'stopped',
      reason: 'user',
      spend: { usd: 0.42, tokens: 900 },
    })
    expect(service.get(view.id).turn).toMatchObject({
      state: 'stopped',
      reason: 'user',
      spend: { usd: 0.42, tokens: 900 },
      startedAt: message.at,
    })
  })

  it('gives each task message the task’s latest state', () => {
    const { service, view } = group()
    const { message } = service.send(view.id, {
      way: 'task',
      text: '整理成一页说明',
      to: 'ct-rev',
      task: {
        title: '写说明',
        deliverable: '一页 Markdown',
        access: 'group_files',
      },
    })
    service.append(view.id, 'group/task', {
      ...message.task!,
      state: 'running',
    })
    service.append(view.id, 'group/task', { ...message.task!, state: 'done' })
    const shown = service
      .history(view.id)
      .messages.find((m) => m.id === message.id)!
    expect(shown.task).toMatchObject({ title: '写说明', state: 'done' })
  })

  it('announces a reveal and a task’s new state, which change how messages show', () => {
    const { service, view, changes } = group()
    changes.length = 0
    service.append(view.id, 'group/reveal', { batchId: 'gb_1' })
    service.append(view.id, 'group/task', {
      taskId: 'gt_1',
      to: 'ct-rev',
      title: 't',
      deliverable: 'd',
      access: 'readonly',
      state: 'cancelled',
    })
    service.append(view.id, 'group/delivery', {
      contactId: 'ct-rev',
      upTo: 'x',
    })
    expect(changes).toEqual([
      { reason: 'message', groupId: view.id },
      { reason: 'message', groupId: view.id },
    ])
  })
})

describe('the user’s answers in the group log (GRP-12)', () => {
  it('keeps an answer where it was given, for the user only', () => {
    const { service, view, logs, changes } = group()
    const asked = service.send(view.id, {
      way: 'mention',
      ask: ['ct-arch'],
      text: '@架构师 看看',
    })
    service.append(view.id, 'group/turn', {
      turnId: asked.message.turnId,
      state: 'started',
      spend: { usd: 0, tokens: 0 },
    })
    changes.length = 0
    const note = service.recordAnswer(view.id, {
      contactId: 'ct-arch',
      outcome: 'answered',
      subject: 'question',
      asked: '先看哪一部分？',
      reply: '登录',
    })
    expect(note).toMatchObject({
      contactId: 'ct-arch',
      turnId: asked.message.turnId,
      outcome: 'answered',
      reply: '登录',
    })
    expect(changes).toEqual([{ reason: 'message', groupId: view.id }])
    expect(logs.get(view.id)!.at(-1)).toEqual({
      type: 'group/answer',
      data: note,
    })
    service.send(view.id, { way: 'broadcast', text: '好的，继续' })
    const { messages } = service.history(view.id)
    expect(messages.map((m) => [m.from, m.kind, m.text])).toEqual([
      ['user', 'say', '@架构师 看看'],
      ['ct-emperor', 'say', '已请架构师回答。'],
      ['system', 'system', '你回答了 架构师 的提问：登录'],
      ['user', 'say', '好的，继续'],
    ])
    const shown = messages[2]!
    expect(shown).toMatchObject({
      id: note.id,
      turnId: asked.message.turnId,
      private: true,
      hidden: false,
      note: { contactId: 'ct-arch', asked: '先看哪一部分？' },
    })
    // It is not a message: no member is ever delivered it, the digest and
    // the counts never see it.
    const state = service.state(view.id)
    expect(state.messages).toHaveLength(3)
    for (const member of ['ct-emperor', 'ct-arch', 'ct-rev'])
      expect(pendingDelivery(state, member).map((m) => m.text)).not.toContain(
        '你回答了 架构师 的提问：登录',
      )
    expect(
      digestSource(state, () => 1, 0)?.messages.map((m) => m.text),
    ).toEqual(['@架构师 看看', '已请架构师回答。', '好的，继续'])
    expect(service.get(view.id).messageCount).toBe(3)
  })

  it('names the member as it is called now, or as a deleted contact', () => {
    const contacts = CONTACTS.map((c) => ({ ...c }))
    const f = fixture(contacts)
    const { service, view } = group(f)
    service.recordAnswer(view.id, {
      contactId: 'ct-rev',
      outcome: 'denied',
      subject: 'approval',
      asked: 'npm test',
    })
    contacts.find((c) => c.id === 'ct-rev')!.name = '代码审稿人'
    expect(service.history(view.id).messages[0]!.text).toBe(
      '你拒绝了 代码审稿人 的请求：npm test',
    )
    contacts.splice(
      contacts.findIndex((c) => c.id === 'ct-rev'),
      1,
    )
    expect(service.history(view.id).messages[0]!.text).toBe(
      '你拒绝了 已删除的联系人 的请求：npm test',
    )
  })

  it('pages with the messages around it', () => {
    const { service, view } = group()
    service.send(view.id, { way: 'broadcast', text: '一' })
    service.recordAnswer(view.id, {
      contactId: 'ct-arch',
      outcome: 'skipped',
      subject: 'question',
      asked: '甲',
    })
    service.send(view.id, { way: 'broadcast', text: '二' })
    service.recordAnswer(view.id, {
      contactId: 'ct-arch',
      outcome: 'approved',
      subject: 'approval',
      asked: '乙',
    })
    service.send(view.id, { way: 'broadcast', text: '三' })
    const last = service.history(view.id, { limit: 1 })
    expect(last.messages.map((m) => m.text)).toEqual(['三'])
    const middle = service.history(view.id, {
      limit: 1,
      before: last.messages[0]!.id,
    })
    expect(middle.messages.map((m) => m.text)).toEqual([
      '二',
      '你批准了 架构师 的请求：乙',
    ])
    const first = service.history(view.id, {
      limit: 5,
      before: middle.messages[0]!.id,
    })
    expect(first.messages.map((m) => m.text)).toEqual([
      '一',
      '你没有回答 架构师 的提问：甲',
    ])
    expect(first.more).toBe(false)
  })

  it('reads a log written before answers were kept, and skips what it does not know', () => {
    const { service, view, logs } = group()
    service.send(view.id, { way: 'broadcast', text: '旧消息' })
    logs.get(view.id)!.push({ type: 'group/from-a-later-version', data: {} })
    expect(service.history(view.id).messages.map((m) => m.text)).toEqual([
      '旧消息',
    ])
    expect(foldGroupEvents(logs.get(view.id)!).answers).toEqual([])
  })

  it('refuses an answer for an unknown group', () => {
    const { service } = group()
    expect(() =>
      service.recordAnswer('grp-none', {
        contactId: 'ct-arch',
        outcome: 'answered',
        subject: 'question',
        asked: '',
      }),
    ).toThrow(GroupError)
  })
})

describe('GroupService.delete (GRP-16)', () => {
  it('hands the group and its member sessions to the trash and says it is deleted', () => {
    const { service, view, changes, trashedGroups, sessions } = group()
    changes.length = 0
    expect(service.delete(view.id)).toEqual({
      id: view.id,
      deleted: true,
      restorableUntil: '2026-11-27T00:00:00.000Z',
    })
    expect(trashedGroups).toEqual([view.id])
    expect(changes).toEqual([{ reason: 'deleted', groupId: view.id }])
    expect(service.list()).toEqual([])
    expect([...sessions.values()]).toEqual([])
  })

  it('refuses an unknown group or a session that is not one', () => {
    const f = fixture()
    const chat = f.sessions
    chat.set('chat-1', { id: 'chat-1', title: '对话' })
    for (const id of ['grp-none', 'chat-1'])
      expect(() => f.service.delete(id)).toThrow(
        expect.objectContaining({ code: 'group_not_found' }),
      )
    expect(f.trashedGroups).toEqual([])
    expect(f.changes).toEqual([])
  })
})

describe('GroupService.leaveAll (GRP-16)', () => {
  it('takes a deleted contact out of every group it is in; what it said stays', () => {
    const f = fixture()
    const a = f.service.create({
      title: 'a',
      members: ['ct-arch', 'ct-rev'],
      moderator: 'ct-rev',
      settings: { coordination: 'member' },
    })
    const b = f.service.create({
      title: 'b',
      members: ['ct-arch'],
      settings: { coordination: 'member' },
    })
    const c = f.service.create({
      title: 'c',
      members: ['ct-rev', 'ct-emperor'],
      settings: { coordination: 'member' },
    })
    f.service.send(a.id, { way: 'broadcast', text: '开始' })
    f.changes.length = 0

    expect(f.service.leaveAll('ct-rev')).toEqual([a.id, c.id])
    expect(f.service.get(a.id)).toMatchObject({ moderator: null })
    expect(f.service.get(a.id).members.map((m) => m.id)).toEqual([
      'ct-emperor',
      'ct-arch',
    ])
    expect(f.service.get(b.id).members.map((m) => m.id)).toEqual([
      'ct-emperor',
      'ct-arch',
    ])
    expect(f.service.get(c.id)).toMatchObject({ moderator: 'ct-emperor' })
    expect(f.service.get(c.id).members.map((m) => m.id)).toEqual(['ct-emperor'])
    expect(f.service.history(a.id).messages.map((m) => m.text)).toEqual([
      '开始',
    ])
    expect(f.changes).toEqual([
      { reason: 'member', groupId: a.id },
      { reason: 'member', groupId: c.id },
    ])
    expect(f.service.leaveAll('ct-rev')).toEqual([])
  })
})

describe('role creator membership (CG-CT-01)', () => {
  it('refuses the fixed creator both at group creation and when added later', () => {
    const creator: GroupContact = {
      id: 'ct-role-creator',
      name: '角色创建师',
      intro: '固定内置',
      kind: 'local',
      speak: 'mentioned',
      version: 1,
    }
    const { service } = fixture([...CONTACTS, creator])
    expect(() =>
      service.create({ title: '错误成员', members: ['ct-role-creator'] }),
    ).toThrow('角色创建师不能加入普通工作群')
    const group = service.create({ title: '正常群', members: ['ct-arch'] })
    expect(() => service.addMember(group.id, 'ct-role-creator')).toThrow(
      '角色创建师不能加入普通工作群',
    )
  })
})
