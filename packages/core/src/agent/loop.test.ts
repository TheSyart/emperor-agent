import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ModelRoute, ProviderSnapshot } from '../model/router'
import { LLMProvider, type ChatArgs, type LLMResponse } from '../providers/base'
import { AgentLoop } from './loop'
import { CancelledTaskError } from '../runtime/active'
import { CompactionCursorStore } from '../memory/compaction-ledger'

const TEMPLATES_DIR = join(__dirname, '..', '..', '..', '..', 'templates')

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function symlinkDirectory(target: string, path: string): void {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}

function skillDocument(
  name: string,
  description: string,
  body: string,
): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
}

async function withEnv(
  name: string,
  value: string | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    await fn()
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

class FakeProvider extends LLMProvider {
  calls: ChatArgs[] = []
  constructor() {
    super({ defaultModel: 'fake-main' })
  }
  async chat(args: ChatArgs): Promise<LLMResponse> {
    this.calls.push(args)
    if (this.calls.length === 1) {
      return response(null, {
        toolCalls: [
          { id: 'call_1', name: 'read_file', arguments: { path: 'hello.txt' } },
        ],
        finishReason: 'tool_calls',
      })
    }
    return response('读完了。')
  }
}

describe('AgentLoop (MIG-CORE-011)', () => {
  it('assembles core subsystems and runs a user turn through a real tool loop', async () => {
    const root = tmp('emperor-agent-loop-')
    writeFileSync(join(root, 'hello.txt'), 'hello from workspace\n', 'utf8')
    const provider = new FakeProvider()
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const events: Array<Record<string, unknown>> = []

    const reply = await loop.runUserTurn('读取 hello.txt', {
      turnId: 'turn_1',
      emit: async (event) => {
        events.push(event)
      },
    })

    expect(reply).toBe('读完了。')
    expect(loop.registry.has('read_file')).toBe(true)
    expect(loop.registry.has('web_search')).toBe(true)
    expect(loop.registry.has('dispatch_subagent')).toBe(true)
    expect(loop.registry.has('scheduler')).toBe(true)
    expect(loop.registry.has('spawn_teammate')).toBe(true)
    expect(loop.activeSessionId).toBeTruthy()
    expect(provider.calls).toHaveLength(2)
    expect(JSON.stringify(provider.calls[1]!.messages)).toContain(
      'hello from workspace',
    )
    expect(loop.history.at(-1)).toMatchObject({
      role: 'assistant',
      content: '读完了。',
    })
    expect(
      loop.activeMemoryStore.loadUnarchivedHistory().map((item) => item.role),
    ).toEqual(['user', 'assistant'])
    expect(events.map((event) => event.event)).toContain('tool_call')
    expect(
      existsSync(
        join(
          root,
          '.emperor',
          'sessions',
          loop.activeSessionId!,
          'history.jsonl',
        ),
      ),
    ).toBe(true)
  })

  it('applies configured PreToolUse hooks through the real loop runtime', async () => {
    const root = tmp('emperor-agent-loop-hooks-')
    const stateRoot = join(root, '.emperor')
    mkdirSync(stateRoot, { recursive: true })
    writeFileSync(join(root, 'hello.txt'), 'secret content\n', 'utf8')
    writeFileSync(
      join(stateRoot, 'hooks_config.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              id: 'deny-read',
              matcher: 'read_file',
              handler: {
                type: 'command',
                command: process.execPath,
                args: [
                  '-e',
                  'process.stdout.write(JSON.stringify({decision:"deny",reason:"blocked read"}))',
                ],
              },
            },
          ],
        },
      }),
    )
    const provider = new FakeProvider()
    const loop = await AgentLoop.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const events: Array<Record<string, unknown>> = []

    await loop.runUserTurn('读取 hello.txt', {
      turnId: 'turn_hooks',
      emit: async (event) => {
        events.push(event)
      },
    })

    const secondCall = provider.calls[1]!
    const toolMessage = secondCall.messages.find(
      (message) => message.role === 'tool',
    )
    expect(String(toolMessage?.content ?? '')).toContain('blocked read')
    expect(String(toolMessage?.content ?? '')).not.toContain('secret content')
    expect(events.map((event) => event.event)).toContain('hook_run_started')
    expect(
      (await loop.hookService.audit.replayRuns()).records.some(
        (record) => record.groupId === 'deny-read',
      ),
    ).toBe(true)
  })

  it('rejects an unavailable model before recording user history', async () => {
    const root = tmp('emperor-agent-loop-no-model-')
    const provider = new FakeProvider()
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: Object.assign(fakeRouter(provider), {
        availability: {
          usable: false,
          code: 'model_configuration_required' as const,
          message: '请先配置模型',
          action: 'open_model_settings' as const,
          provider: 'deepseek',
          entryName: null,
        },
      }),
    })
    const events: Array<Record<string, unknown>> = []

    await expect(
      loop.runUserTurn('hi', {
        turnId: 'turn_no_model',
        emit: async (event) => {
          events.push(event)
        },
      }),
    ).rejects.toMatchObject({
      code: 'model_configuration_required',
      action: 'open_model_settings',
    })

    expect(provider.calls).toHaveLength(0)
    expect(loop.history).toEqual([])
    expect(loop.activeMemoryStore.loadUnarchivedHistory()).toEqual([])
    expect(events.map((event) => event.event)).not.toContain('user_message')
  })

  it('runs build session file tools inside the bound project workspace', async () => {
    const root = tmp('emperor-agent-loop-core-root-')
    const projectRoot = tmp('emperor-agent-loop-project-')
    writeFileSync(
      join(root, 'package.json'),
      '{"name":"wrong-core-root"}\n',
      'utf8',
    )
    writeFileSync(join(root, 'core-only.txt'), 'core root file\n', 'utf8')
    writeFileSync(
      join(projectRoot, 'package.json'),
      '{"name":"right-project-root"}\n',
      'utf8',
    )
    writeFileSync(
      join(projectRoot, 'project-only.txt'),
      'project root file\n',
      'utf8',
    )
    const provider = new QueueProvider([
      response(null, {
        toolCalls: [
          { id: 'call_glob', name: 'glob', arguments: { pattern: '*.txt' } },
          {
            id: 'call_read_relative',
            name: 'read_file',
            arguments: { path: 'package.json' },
          },
          {
            id: 'call_read_absolute',
            name: 'read_file',
            arguments: { path: join(projectRoot, 'package.json') },
          },
          {
            id: 'call_pwd',
            name: 'run_command',
            arguments: { command: 'pwd' },
          },
        ],
        finishReason: 'tool_calls',
      }),
      response('读完了。'),
    ])
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const project = loop.projectStore.resolve(projectRoot)
    const buildSession = loop.sessionStore.create('Build project', {
      mode: 'build',
      project: project as unknown as Record<string, unknown>,
    })
    loop.activateSession(buildSession.id)

    await loop.runUserTurn('读取 package.json', {
      turnId: 'turn_1',
      emit: async () => {},
    })

    const toolOutputs = provider.calls[1]!.messages.filter(
      (message) => message.role === 'tool',
    )
      .map((message) => String(message.content ?? ''))
      .join('\n')
    expect(toolOutputs).toContain('right-project-root')
    expect(toolOutputs).toContain('project-only.txt')
    expect(toolOutputs).toContain(projectRoot)
    expect(toolOutputs).not.toContain('wrong-core-root')
    expect(toolOutputs).not.toContain('core-only.txt')
    expect(provider.calls[0]!.messages[0]!.content).toContain(
      `Workspace root: \`${projectRoot}\``,
    )
  })

  it('keeps an in-flight turn bound to its starting session when active session changes', async () => {
    const root = tmp('emperor-agent-loop-turn-scope-')
    const provider = new DelayedProvider()
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const firstSessionId = loop.activeSessionId!
    const second = loop.sessionStore.create('Second chat')
    const emitted: Array<Record<string, unknown>> = []

    const running = loop.runUserTurn('先在第一个会话里回答', {
      turnId: 'turn_scope_1',
      emit: async (event) => {
        emitted.push(event)
      },
    })
    await provider.started
    loop.activateSession(second.id)
    provider.finish(response('只应写回第一个会话。'))

    await expect(running).resolves.toBe('只应写回第一个会话。')

    const firstHistory = readFileSync(
      join(root, '.emperor', 'sessions', firstSessionId, 'history.jsonl'),
      'utf8',
    )
    const secondHistoryPath = join(
      root,
      '.emperor',
      'sessions',
      second.id,
      'history.jsonl',
    )
    const secondHistory = existsSync(secondHistoryPath)
      ? readFileSync(secondHistoryPath, 'utf8')
      : ''
    expect(firstHistory).toContain('只应写回第一个会话。')
    expect(secondHistory).not.toContain('只应写回第一个会话。')
    expect(loop.sessionStore.get(firstSessionId)?.message_count).toBe(2)
    expect(loop.sessionStore.get(second.id)?.message_count).toBe(0)
    expect(emitted.find((event) => event.event === 'turn_scope')).toMatchObject(
      {
        session_id: firstSessionId,
        turn_id: 'turn_scope_1',
        state_root: join(root, '.emperor'),
        session_root: join(root, '.emperor', 'sessions', firstSessionId),
        active_memory_binding: {
          profile: {
            scope: { kind: 'user_profile' },
            readable: true,
            writable: true,
            path: join(root, '.emperor', 'memory', 'profile', 'USER.local.md'),
          },
          longTerm: {
            scope: { kind: 'global' },
            readable: true,
            writable: true,
            path: join(root, '.emperor', 'memory', 'MEMORY.local.md'),
          },
        },
      },
    )
  })

  it('restores the previous active session after a background turn targets another session', async () => {
    const root = tmp('emperor-agent-loop-bg-session-')
    const provider = new DelayedProvider()
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const firstSessionId = loop.activeSessionId!
    const second = loop.sessionStore.create('Background target')

    const running = loop.runUserTurn('后台会话执行', {
      sessionId: second.id,
      restoreActiveSessionAfterTurn: true,
      turnId: 'turn_background_session',
    })
    await provider.started
    expect(loop.activeSessionId).toBe(second.id)
    provider.finish(response('后台完成。'))

    await expect(running).resolves.toBe('后台完成。')

    expect(loop.activeSessionId).toBe(firstSessionId)
    const secondHistory = readFileSync(
      join(root, '.emperor', 'sessions', second.id, 'history.jsonl'),
      'utf8',
    )
    expect(secondHistory).toContain('后台完成。')
  })

  it('auto-compacts stable completed turns through compactSession when explicitly enabled', async () => {
    const root = tmp('emperor-agent-loop-auto-compact-')
    const provider = new QueueProvider([
      response('新回复。', { usage: { input: 90_000, output: 4 } }),
      response(
        JSON.stringify({
          schemaVersion: 'emperor.compaction-draft.v1',
          episode: {
            operations: [
              {
                op: 'append_section_item',
                section: 'Summary',
                content: '- Auto compacted old completed chat turns.',
                reason: 'token threshold summarized stable history',
                sourceSeqs: [1, 2, 3, 4],
                confidence: 'high',
              },
            ],
          },
          userProfile: {
            operations: [
              {
                op: 'append_section_item',
                section: 'Stable Preferences',
                content:
                  '- Prefers automatic scoped compaction when context is high.',
                reason: 'stable user preference from old turns',
                sourceSeqs: [1],
                confidence: 'high',
              },
            ],
          },
          globalMemory: {
            operations: [
              {
                op: 'append_section_item',
                section: 'Cross-Project Decisions',
                content:
                  '- Auto compaction uses compactSession and keeps session history.',
                reason: 'durable system behavior',
                sourceSeqs: [2],
                confidence: 'high',
              },
            ],
          },
          decisions: [],
          discarded: [],
        }),
      ),
    ])
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    for (let i = 1; i <= 5; i++) {
      loop.activeMemoryStore.appendHistory('user', `old user ${i}`, {
        extra: { turn_id: `old_${i}` },
      })
      loop.activeMemoryStore.appendHistory('assistant', `old assistant ${i}`, {
        extra: { turn_id: `old_${i}` },
      })
    }

    const emitted: Array<Record<string, unknown>> = []
    await withEnv('EMPEROR_AUTO_MEMORY_COMPACT', '1', async () => {
      const reply = await loop.runUserTurn('触发自动压缩', {
        turnId: 'turn_auto_compact',
        emit: (event) => {
          emitted.push(event)
        },
      })
      expect(reply).toBe('新回复。')
    })

    expect(provider.calls).toHaveLength(2)
    expect(
      emitted.filter((event) => event.event === 'record_degraded'),
    ).toEqual([])
    expect(provider.calls[1]!.model).toBe('fake-secondary')
    expect(loop.sharedMemory.readMemory()).toContain(
      'Auto compaction uses compactSession',
    )
    expect(loop.sharedMemory.readUser()).toContain(
      'automatic scoped compaction',
    )
    expect(loop.sharedMemory.readTodayEpisode()).toContain(
      'Auto compacted old completed chat turns',
    )
    expect(
      loop.activeMemoryStore.loadUnarchivedHistory().map((row) => row.role),
    ).toHaveLength(8)
    expect(loop.history.map((row) => row.role)).toHaveLength(8)
    const cursor = new CompactionCursorStore(loop.paths.stateRoot).readOrInit(
      loop.activeSessionId!,
    )
    expect(cursor.compactedUntilSeq).toBeGreaterThanOrEqual(4)
    expect(cursor.archivedUntilSeq).toBeGreaterThanOrEqual(4)

    await loop.runUserTurn('压缩后的下一轮', { turnId: 'turn_after_compact' })
    const snapshot = JSON.parse(
      readFileSync(
        join(
          loop.sessionStore.sessionDir(loop.activeSessionId!),
          'prompt-snapshots',
          'turn_after_compact.json',
        ),
        'utf8',
      ),
    )
    expect(snapshot.contextPlan.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'session_history',
          reason: 'semantic_compaction_applied',
          fromSeq: 1,
          toSeq: cursor.compactedUntilSeq,
          compactionId: cursor.lastCompactionId,
          targetScopes: expect.arrayContaining(['global', 'user_profile']),
        }),
      ]),
    )
  })

  it('keeps unfinished todos scoped to the session that created them', async () => {
    const root = tmp('emperor-agent-loop-todo-session-scope-')
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new QueueProvider([response('done')])),
    })
    const firstSessionId = loop.activeSessionId!

    loop.todoStore.update([
      { id: 1, content: '旧会话待办', status: 'in_progress' },
    ])

    const second = loop.sessionStore.create('Second chat')
    loop.activateSession(second.id)
    expect(loop.todoStore.todos).toEqual([])

    loop.todoStore.update([
      { id: 1, content: '第二会话待办', status: 'pending' },
    ])
    loop.activateSession(firstSessionId)
    expect(loop.todoStore.todos).toMatchObject([
      { content: '旧会话待办', status: 'in_progress' },
    ])

    loop.activateSession(second.id)
    expect(loop.todoStore.todos).toMatchObject([
      { content: '第二会话待办', status: 'pending' },
    ])
  })

  it('mirrors waiting ask and plan controls into the active session index', async () => {
    const root = tmp('emperor-agent-loop-control-session-tag-')
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const sessionId = loop.activeSessionId!

    const ask = loop.controlManager.createAsk({
      questions: [
        {
          id: 'scope',
          header: '范围',
          question: '范围怎么定？',
          options: [
            { label: '最小', description: '只做核心' },
            { label: '完整', description: '包含测试' },
          ],
        },
      ],
    })
    expect(loop.sessionStore.get(sessionId)?.control_pending).toMatchObject({
      kind: 'ask',
      label: '需要用户输入',
      tone: 'blue',
      interaction_id: ask.id,
    })

    loop.controlManager.answer(ask.id, { scope: { choice: '完整' } })
    expect(loop.sessionStore.get(sessionId)?.control_pending).toBeNull()

    loop.controlManager.setMode('plan')
    const plan = loop.controlManager.createPlan({
      title: '实现计划',
      summary: '等待确认',
      planMarkdown: '# Plan\n\n- Do it',
      assumptions: [],
      riskLevel: 'low',
    })
    expect(loop.sessionStore.get(sessionId)?.control_pending).toMatchObject({
      kind: 'plan',
      label: '计划需要用户确认',
      tone: 'green',
      interaction_id: plan.id,
    })

    loop.controlManager.cancel(plan.id)
    expect(loop.sessionStore.get(sessionId)?.control_pending).toBeNull()
  })

  it('gates dispatch_subagent tool calls through the real permission pipeline (audit P0-1)', async () => {
    const root = tmp('emperor-agent-loop-dispatch-guard-')
    const marker = join(root, 'marker.txt')
    writeFileSync(marker, 'x', 'utf8')

    const provider = new QueueProvider([
      // 主 agent: 派遣子代理去改权限
      response(null, {
        toolCalls: [
          {
            id: 'call_1',
            name: 'dispatch_subagent',
            arguments: {
              agent_type: 'general',
              task: `把 ${marker} 权限改成 000`,
            },
          },
        ],
        finishReason: 'tool_calls',
      }),
      // 子代理: 尝试跑一条高危命令 (chmod 命中 isHighRiskCommand)
      response(null, {
        toolCalls: [
          {
            id: 'call_2',
            name: 'run_command',
            arguments: { command: `chmod 000 ${marker}` },
          },
        ],
        finishReason: 'tool_calls',
      }),
      // 子代理: 收到"需要审批"结果后收工回禀
      response('未获批准，无法执行该命令。'),
      // 主 agent: 收到子代理回禀后结束回合
      response('已确认小太监未能执行高危命令。'),
    ])
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })

    await loop.runUserTurn('帮我检查一下 marker.txt 这个文件的状态。', {
      turnId: 'turn_1',
      emit: async () => {},
    })

    // 高危命令必须没有真的执行 —— 文件权限位应保持未变。
    const mode = statSync(marker).mode & 0o777
    expect(mode).not.toBe(0)
    // 审批流程应该真实触发（而不是被子代理静默绕过）。
    expect(loop.controlManager.payload().pending).toBeTruthy()
  })

  it('loads local permission rules into the real permission pipeline', async () => {
    const root = tmp('emperor-agent-loop-permission-rules-')
    mkdirSync(join(root, '.emperor'), { recursive: true })
    writeFileSync(
      join(root, '.emperor', 'emperor.local.json'),
      JSON.stringify({
        permissions: {
          rules: [
            {
              id: 'deny-secrets',
              action: 'deny',
              tool: 'write_file',
              pathGlob: 'secrets/**',
              reason: 'secret writes need manual handling',
            },
          ],
        },
      }),
      'utf8',
    )
    const provider = new QueueProvider([
      response(null, {
        toolCalls: [
          {
            id: 'call_1',
            name: 'write_file',
            arguments: { path: 'secrets/key.md', content: 'secret' },
          },
        ],
        finishReason: 'tool_calls',
      }),
      response('没有写入。'),
    ])
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })

    await loop.runUserTurn('写入 secret', {
      turnId: 'turn_rules',
      emit: async () => {},
    })

    const toolOutput = provider.calls[1]!.messages.filter(
      (message) => message.role === 'tool',
    )
      .map((message) => String(message.content ?? ''))
      .join('\n')
    expect(toolOutput).toContain('permission denied')
    expect(toolOutput).toContain('secret writes need manual handling')
    expect(existsSync(join(root, 'secrets', 'key.md'))).toBe(false)
  })

  it('stops a cancelled turn from continuing after the model returns late', async () => {
    const root = tmp('emperor-agent-loop-cancel-turn-')
    const provider = new CancellableProvider()
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const emitted: Array<Record<string, unknown>> = []

    const running = loop.runUserTurn('读取 hello.txt 后继续总结', {
      turnId: 'turn_cancel',
      emit: async (event) => {
        emitted.push(event)
      },
    })
    await provider.secondCallStarted

    const cancelled = loop.activeTasks.cancel({ kind: 'turn' })
    expect(cancelled).toHaveLength(1)
    await expect(running).rejects.toBeInstanceOf(CancelledTaskError)

    provider.finishSecond(response('这条迟到回复不应该进入会话。'))
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(emitted.some((event) => event.event === 'assistant_done')).toBe(
      false,
    )
    expect(
      loop.history.some(
        (message) =>
          message.role === 'assistant' &&
          message.content === '这条迟到回复不应该进入会话。',
      ),
    ).toBe(false)
  })

  it('resolves skills with project > user-global > builtin precedence, and drops project skills outside build sessions', async () => {
    const root = tmp('emperor-agent-loop-skills-root-')
    const stateRoot = join(root, '.emperor')
    const projectRoot = tmp('emperor-agent-loop-skills-project-')
    const builtinGreet = skillDocument(
      'greet',
      'Greet from built-in.',
      'builtin greet',
    )
    const userGreet = skillDocument(
      'greet',
      'Greet from user state.',
      'user greet',
    )
    const userOnly = skillDocument(
      'user-only',
      'Available only from user state.',
      'user-only skill',
    )
    const projectGreet = skillDocument(
      'greet',
      'Greet from the active project.',
      'project greet',
    )
    mkdirSync(join(root, 'skills', 'greet'), { recursive: true })
    writeFileSync(
      join(root, 'skills', 'greet', 'SKILL.md'),
      builtinGreet,
      'utf8',
    )
    mkdirSync(join(stateRoot, 'skills', 'greet'), { recursive: true })
    writeFileSync(
      join(stateRoot, 'skills', 'greet', 'SKILL.md'),
      userGreet,
      'utf8',
    )
    mkdirSync(join(stateRoot, 'skills', 'user-only'), { recursive: true })
    writeFileSync(
      join(stateRoot, 'skills', 'user-only', 'SKILL.md'),
      userOnly,
      'utf8',
    )

    const loop = await AgentLoop.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })

    expect(await loop.registry.execute('load_skill', { name: 'greet' })).toBe(
      userGreet,
    )
    expect(
      await loop.registry.execute('load_skill', { name: 'user-only' }),
    ).toBe(userOnly)

    const project = loop.projectStore.resolve(projectRoot)
    mkdirSync(join(projectRoot, '.emperor', 'skills', 'greet'), {
      recursive: true,
    })
    writeFileSync(
      join(projectRoot, '.emperor', 'skills', 'greet', 'SKILL.md'),
      projectGreet,
      'utf8',
    )
    const buildSession = loop.sessionStore.create('Build project', {
      mode: 'build',
      project: project as unknown as Record<string, unknown>,
    })
    loop.activateSession(buildSession.id)

    expect(await loop.registry.execute('load_skill', { name: 'greet' })).toBe(
      projectGreet,
    )
    expect(
      await loop.registry.execute('load_skill', { name: 'user-only' }),
    ).toBe(userOnly)

    loop.activateSession(
      loop.sessionStore
        .list({ includeArchived: false })
        .find((s) => s.id !== buildSession.id)!.id,
    )

    expect(await loop.registry.execute('load_skill', { name: 'greet' })).toBe(
      userGreet,
    )
  })

  it('expands {{skill_dir}} to the selected canonical directory without rewriting SKILL.md', async () => {
    const root = tmp('emperor-agent-loop-skill-placeholder-root-')
    const stateRoot = join(root, '.emperor')
    const skillDir = join(stateRoot, 'skills', 'path-aware')
    const skillFile = join(skillDir, 'SKILL.md')
    const source = skillDocument(
      'path-aware',
      'Resolve bundled file paths.',
      'Run {{skill_dir}}/scripts/check.mjs',
    )
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(skillFile, source, 'utf8')

    const loop = await AgentLoop.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })

    expect(
      await loop.registry.execute('load_skill', { name: 'path-aware' }),
    ).toBe(source.replaceAll('{{skill_dir}}', realpathSync(skillDir)))
    expect(readFileSync(skillFile, 'utf8')).toBe(source)
  })

  it('exposes Core-native create, validate, and package actions through manage_skill', async () => {
    const root = tmp('emperor-agent-loop-manage-skill-root-')
    const stateRoot = join(root, '.emperor')
    const loop = await AgentLoop.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const refreshRuntimeContext = vi.spyOn(loop, 'refreshRuntimeContext')

    const created = JSON.parse(
      await loop.registry.execute('manage_skill', {
        action: 'create',
        name: 'release-audit',
        description: 'Audit release artifacts and integrity evidence.',
        resources: ['references'],
      }),
    ) as Record<string, unknown>
    expect(created).toMatchObject({ name: 'release-audit', valid: true })
    expect(refreshRuntimeContext).toHaveBeenCalledOnce()

    const validated = JSON.parse(
      await loop.registry.execute('manage_skill', {
        action: 'validate',
        name: 'release-audit',
      }),
    ) as Record<string, unknown>
    expect(validated).toMatchObject({ name: 'release-audit', valid: true })

    const packaged = JSON.parse(
      await loop.registry.execute('manage_skill', {
        action: 'package',
        name: 'release-audit',
      }),
    ) as Record<string, unknown>
    expect(packaged).toMatchObject({
      name: 'release-audit',
      path: join(
        realpathSync(stateRoot),
        'skill-packages',
        'release-audit.skill',
      ),
    })
  })

  it('does not load a Skill through a symbolic-link root', async () => {
    const root = tmp('emperor-agent-loop-skill-link-root-')
    const stateRoot = join(root, '.emperor')
    const outside = tmp('emperor-agent-loop-skill-link-outside-')
    mkdirSync(join(stateRoot, 'skills'), { recursive: true })
    writeFileSync(join(outside, 'SKILL.md'), 'outside skill\n')
    symlinkDirectory(outside, join(stateRoot, 'skills', 'linked'))

    const loop = await AgentLoop.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })

    expect(await loop.registry.execute('load_skill', { name: 'linked' })).toBe(
      '[ERR] skill "linked" not found',
    )
  })

  it('does not load project Skills through a symlinked .emperor ancestor', async () => {
    const root = tmp('emperor-agent-loop-project-skill-link-root-')
    const stateRoot = join(root, '.state')
    const projectRoot = tmp('emperor-agent-loop-project-skill-project-')
    const outside = tmp('emperor-agent-loop-project-skill-outside-')
    const outsideSkill = join(outside, 'skills', 'escaped')
    mkdirSync(outsideSkill, { recursive: true })
    writeFileSync(join(outsideSkill, 'SKILL.md'), 'escaped project skill\n')
    symlinkDirectory(outside, join(projectRoot, '.emperor'))

    const loop = await AgentLoop.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const project = loop.projectStore.resolve(projectRoot)
    const session = loop.sessionStore.create('Linked project', {
      mode: 'build',
      project: project as unknown as Record<string, unknown>,
    })
    loop.activateSession(session.id)

    expect(await loop.registry.execute('load_skill', { name: 'escaped' })).toBe(
      '[ERR] skill "escaped" not found',
    )
  })

  it('skips invalid directory Skills and falls back to the next valid source', async () => {
    const root = tmp('emperor-agent-loop-invalid-skill-root-')
    const stateRoot = join(root, '.state')
    const builtin = join(root, 'skills', 'reviewer')
    const user = join(stateRoot, 'skills', 'reviewer')
    mkdirSync(builtin, { recursive: true })
    mkdirSync(user, { recursive: true })
    writeFileSync(
      join(builtin, 'SKILL.md'),
      '---\nname: reviewer\ndescription: Review code safely.\n---\n\nVALID_BUILTIN\n',
    )
    writeFileSync(
      join(user, 'SKILL.md'),
      '---\nname: reviewer\n---\n\nINVALID_USER\n',
    )

    const loop = await AgentLoop.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })

    expect(
      await loop.registry.execute('load_skill', { name: 'reviewer' }),
    ).toBe(
      '---\nname: reviewer\ndescription: Review code safely.\n---\n\nVALID_BUILTIN\n',
    )
    expect(loop.skillsLoader.summary()).not.toContain('INVALID_USER')
  })
})

class QueueProvider extends LLMProvider {
  private readonly queue: LLMResponse[]
  calls: ChatArgs[] = []
  constructor(queue: LLMResponse[]) {
    super({ defaultModel: 'fake-main' })
    this.queue = queue
  }
  async chat(args: ChatArgs): Promise<LLMResponse> {
    this.calls.push(args)
    return this.queue.length ? this.queue.shift()! : response('done')
  }
}

class CancellableProvider extends LLMProvider {
  calls: ChatArgs[] = []
  private secondStartedResolve: () => void = () => {}
  private secondResolve: (response: LLMResponse) => void = () => {}
  readonly secondCallStarted = new Promise<void>((resolve) => {
    this.secondStartedResolve = resolve
  })

  constructor() {
    super({ defaultModel: 'fake-main' })
  }

  async chat(args: ChatArgs): Promise<LLMResponse> {
    this.calls.push(args)
    if (this.calls.length === 1) {
      return response(null, {
        toolCalls: [
          { id: 'call_1', name: 'read_file', arguments: { path: 'hello.txt' } },
        ],
        finishReason: 'tool_calls',
      })
    }
    this.secondStartedResolve()
    return new Promise<LLMResponse>((resolve) => {
      this.secondResolve = resolve
    })
  }

  finishSecond(response: LLMResponse): void {
    this.secondResolve(response)
  }
}

class DelayedProvider extends LLMProvider {
  private startedResolve: () => void = () => {}
  private responseResolve: (response: LLMResponse) => void = () => {}
  readonly started = new Promise<void>((resolve) => {
    this.startedResolve = resolve
  })

  constructor() {
    super({ defaultModel: 'fake-main' })
  }

  async chat(): Promise<LLMResponse> {
    this.startedResolve()
    return new Promise<LLMResponse>((resolve) => {
      this.responseResolve = resolve
    })
  }

  finish(response: LLMResponse): void {
    this.responseResolve(response)
  }
}

function fakeRouter(provider: LLMProvider): {
  route: (
    useCase: string,
    agentType?: string | null,
    task?: string | null,
  ) => ModelRoute
  payload: () => Record<string, unknown>
} {
  return {
    route: (
      useCase: string,
      _agentType?: string | null,
      _task?: string | null,
    ) => ({
      snapshot: snapshot(
        provider,
        useCase === 'main_agent' ? 'main' : 'secondary',
      ),
      fallback: null,
      useCase,
      reason: `${useCase}:fake`,
      estimatedTokens: null,
    }),
    payload: () => ({
      mainModel: 'fake-main',
      secondaryModel: 'fake-secondary',
    }),
  }
}

function snapshot(
  provider: LLMProvider,
  role: 'main' | 'secondary',
): ProviderSnapshot {
  return {
    provider,
    providerName: 'fake',
    providerLabel: 'Fake',
    model: role === 'main' ? 'fake-main' : 'fake-secondary',
    apiBase: null,
    generation: { maxTokens: 2000, temperature: 0.1, reasoningEffort: null },
    contextWindowTokens: 100_000,
    config: {},
    supportsVision: true,
    entryName: 'fake',
    entryLabel: 'Fake',
    modelRole: role,
    routeReason: `${role}_model`,
  }
}

function response(
  content: string | null,
  opts: Partial<LLMResponse> = {},
): LLMResponse {
  return {
    content,
    toolCalls: opts.toolCalls ?? [],
    finishReason: opts.finishReason ?? 'stop',
    usage: opts.usage ?? { input: 1, output: 1 },
    reasoningContent: null,
    thinkingBlocks: null,
  }
}
