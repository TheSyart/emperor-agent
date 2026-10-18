import { describe, expect, it } from 'vitest'
import type { AgentView } from '@emperor/core/api'
import type { ToolChatData } from '../../../conversation/types'
import { REGISTERED_TOOLS, subagentStatusLabel, toolView } from './registry'
import {
  errorSummary,
  grepCard,
  hunksFromUnifiedDiff,
  mutationHunks,
  nativeAgentTarget,
  readWindow,
  shellOutcome,
  toolRowState,
} from './toolModel'

function tool(
  name: string,
  args: unknown,
  result?: {
    text: string
    isError?: boolean
    meta?: unknown
    code?: string
  },
  extra: Partial<ToolChatData> = {},
): ToolChatData {
  return {
    callId: `call-${name}`,
    name,
    argsRaw: JSON.stringify(args),
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
            isError: result.isError === true,
            ...(result.meta === undefined
              ? {}
              : { meta: result.meta as never }),
            ...(result.code === undefined
              ? {}
              : { error: { name: 'ToolError', code: result.code } }),
          },
        }),
    ...extra,
  } as ToolChatData
}

const row = (data: ToolChatData) => {
  const view = toolView(data.name)
  return {
    title: view.title(data),
    summary: view.summary(data),
    body: view.body,
  }
}

describe('tool registry titles and summaries', () => {
  it('routes fetch and structured MCP resources while preserving unknown MCP results', () => {
    expect(toolView('web_fetch').body).toBe('resource')
    const github = tool(
      'mcp_github_pull_request_read',
      { number: 12 },
      {
        text: '{"html_url":"https://github.com/a/b/pull/12","title":"Fix"}',
        meta: { server: 'github', tool: 'pull_request_read' },
      },
    )
    expect(toolView(github.name, github).body).toBe('resource')
    const unknown = tool(
      'mcp_docs_logs',
      {},
      { text: 'Log https://github.com/a/b/pull/12' },
    )
    expect(toolView(unknown.name, unknown).body).toBe('mcp')
    const imageOnly = {
      ...unknown,
      result: {
        ...unknown.result!,
        content: [
          {
            type: 'image' as const,
            attachment: {
              attachmentId: 'screen-1',
              mediaType: 'image/png',
              bytes: 42,
            },
          },
        ],
      },
    }
    expect(toolView(imageOnly.name, imageOnly).body).toBe('mcp')
  })

  it('bash: description, background job status', () => {
    expect(
      row(tool('bash', { command: 'ls -la', description: 'List files' })),
    ).toEqual({
      title: '终端',
      summary: 'List files',
      body: 'bash',
    })
    expect(row(tool('bash', { command: 'echo hi\necho there' })).summary).toBe(
      'echo hi',
    )
    const bg = tool(
      'bash',
      { command: 'make', description: 'Build', run_in_background: true },
      {
        text: 'started background job job-1',
        meta: { kind: 'background', jobId: 'job-1' },
      },
      { job: { jobId: 'job-1', status: 'running' } },
    )
    expect(row(bg).summary).toBe('Build · 后台 运行中')
  })

  it('read: path and line window', () => {
    expect(row(tool('read', { file_path: 'src/a.ts' }))).toMatchObject({
      title: '读取',
      summary: 'src/a.ts',
      body: 'read',
    })
    const windowed = tool(
      'read',
      { file_path: '/Users/me/project/src/deep/a.ts', offset: 10, limit: 20 },
      {
        text: '',
        meta: {
          path: '/Users/me/project/src/deep/a.ts',
          startLine: 10,
          endLine: 29,
          totalLines: 90,
        },
      },
    )
    expect(row(windowed).summary).toBe('…/src/deep/a.ts · 第 10–29 行')
  })

  it('write / edit / memory_edit', () => {
    expect(
      row(
        tool(
          'write',
          { file_path: 'a.md', content: 'x' },
          { text: 'ok', meta: { operation: 'create', path: 'a.md' } },
        ),
      ).title,
    ).toBe('新建')
    expect(row(tool('write', { file_path: 'a.md', content: 'x' })).title).toBe(
      '写入',
    )
    expect(
      row(
        tool('edit', { file_path: 'a.md', old_string: 'a', new_string: 'b' }),
      ),
    ).toMatchObject({ title: '编辑', summary: 'a.md', body: 'diff' })
    expect(
      row(tool('memory_edit', { target: 'user', new_string: 'x' })),
    ).toMatchObject({ title: '记忆', summary: '用户档案 · 追加' })
    expect(
      row(
        tool('memory_edit', {
          target: 'memory',
          old_string: 'a',
          new_string: 'b',
        }),
      ).summary,
    ).toBe('长期记忆 · 替换')
  })

  it('glob / grep with result counts', () => {
    expect(
      row(
        tool(
          'glob',
          { pattern: '**/*.ts' },
          {
            text: 'a.ts\nb.ts',
            meta: { matches: 2, truncated: false, files: ['a.ts', 'b.ts'] },
          },
        ),
      ).summary,
    ).toBe('**/*.ts · 2 个路径')
    const grep = tool(
      'grep',
      { pattern: 'foo', include: '*.ts' },
      {
        text: 'Found 3 matches\n\nsrc/a.ts\nLine 1: foo\nLine 9: foo()\n\nsrc/b.ts\nLine 2: foo',
        meta: { matches: 3, truncated: false, files: ['src/a.ts', 'src/b.ts'] },
      },
    )
    expect(row(grep)).toMatchObject({
      title: '搜索',
      summary: 'foo · *.ts · 3 处匹配',
      body: 'grep',
    })
    expect(grepCard(grep)?.files).toEqual([
      {
        path: 'src/a.ts',
        matches: [
          { lineNumber: 1, line: 'foo' },
          { lineNumber: 9, line: 'foo()' },
        ],
      },
      { path: 'src/b.ts', matches: [{ lineNumber: 2, line: 'foo' }] },
    ])
  })

  it('web_search, todo_write, skill, scheduler', () => {
    expect(
      row(
        tool(
          'web_search',
          { queries: ['a', 'b'] },
          {
            text: '',
            meta: { sources: [{ url: 'https://x.dev' }], truncated: false },
          },
        ),
      ).summary,
    ).toBe('a、b · 1 个来源')
    const todo = tool('todo_write', {
      todos: [
        { content: 'one', status: 'completed' },
        { content: 'two', status: 'in_progress' },
        { content: 'three', status: 'in_progress' },
      ],
    })
    expect(row(todo).summary).toBe('已完成 1/3 · two')
    expect(toolView('todo_write').suffix?.(todo)).toBe('+1')
    expect(row(tool('skill', { name: 'pdf' }))).toMatchObject({
      title: '技能',
      summary: 'pdf',
      body: 'skill',
    })
    expect(
      row(tool('scheduler', { action: 'add', name: '晨报' })).summary,
    ).toBe('新建 · 晨报')
    expect(
      row(tool('mcp_config', { action: 'disable', name: 'aihot' })),
    ).toMatchObject({ title: 'MCP 配置', summary: '停用 · aihot' })
  })

  it('ask_user_question follows the interaction outcome', () => {
    const args = {
      questions: [{ id: 'q', question: 'Which?', options: [{ label: 'a' }] }],
    }
    expect(row(tool('ask_user_question', args)).summary).toBe(
      '等待回答 · Which?',
    )
    const answered = tool(
      'ask_user_question',
      args,
      { text: '{}' },
      {
        question: {
          id: 'x',
          questions: args.questions as never,
          outcome: 'answered',
          answers: { q: { selected: ['a'] } },
        },
      },
    )
    expect(row(answered).summary).toBe('已回答 1/1 · Which?')
    const cancelled = tool(
      'ask_user_question',
      args,
      { text: '', isError: true },
      {
        question: {
          id: 'x',
          questions: args.questions as never,
          outcome: 'cancelled',
        },
      },
    )
    expect(row(cancelled).summary).toBe('已取消 · Which?')
  })

  it('exit_plan_mode reports the review outcome', () => {
    const plan = { plan: '# Ship it\n\n1. do' }
    expect(row(tool('exit_plan_mode', plan)).summary).toBe('Ship it · 等待审阅')
    expect(
      row(
        tool('exit_plan_mode', plan, { text: 'ok', meta: { approved: true } }),
      ).summary,
    ).toBe('Ship it · 已批准')
    expect(
      row(
        tool('exit_plan_mode', plan, {
          text: 'The user chose to keep planning; their feedback: more tests',
          isError: true,
          code: 'PLAN_REJECTED',
        }),
      ).summary,
    ).toBe('Ship it · 继续规划')
    // A dismissed review is a successful, turn-ending result, never an approval.
    expect(
      row(
        tool('exit_plan_mode', plan, {
          text: 'The user dismissed the plan review to reply in their own words; plan mode remains active.',
          meta: { approved: false, dismissed: true },
        }),
      ).summary,
    ).toBe('Ship it · 已取消')
  })

  it('names native continuation cards from their matched stable shared identity and preserves external behavior', () => {
    const child: AgentView = {
      id: 'sub-existing',
      kind: 'internal',
      backend: 'internal',
      rootSessionId: 'root',
      parentAgentId: 'root',
      title: 'creation task',
      phase: 'waiting',
      createdAt: 1,
      updatedAt: 2,
    }
    const native = tool(
      'send_message',
      { subagent_id: child.id, message: 'new followup' },
      { text: 'queued', meta: { messageId: 'msg-next', subagentId: child.id } },
    )
    const view = toolView('send_message', undefined, child)
    expect(view.title(native)).toBe('creation task')
    expect(view.summary(native)).toBe('Emperor · 等待回答')
    expect(nativeAgentTarget(native)).toBe(child.id)
    expect(
      view.title(
        tool('send_message', { subagent_id: 'sub-other', message: 'other' }),
      ),
    ).toBe('发送消息')
    for (const id of ['dlg-one', 'dgr-one', 'root', 'sub-'])
      expect(
        nativeAgentTarget(
          tool(
            'send_message',
            { subagent_id: child.id },
            { text: '', meta: { subagentId: id } },
          ),
        ),
      ).toBeUndefined()
    const external = tool(
      'send_message',
      { agent_id: 'dlg-one', message: 'external followup' },
      undefined,
      {
        externalAgent: {
          title: 'external creation',
          delegationId: 'dlg-one',
          runId: 'dgr-next',
          backend: 'codex',
          phase: 'running',
          text: '',
          activity: [],
        },
      },
    )
    expect(nativeAgentTarget(external)).toBeUndefined()
    expect(view.title(external)).toBe('external creation')
    expect(view.summary(external)).toBe('Codex · 运行中')
  })

  it('keeps continuation cards named after the creation task, with the source separate', () => {
    expect(
      row(
        tool(
          'send_message',
          { agent_id: 'dlg-one', message: 'a different followup task' },
          undefined,
          {
            externalAgent: {
              title: 'creation task',
              delegationId: 'dlg-one',
              runId: 'dgr-next',
              backend: 'claude-code',
              phase: 'outcome_unknown',
              text: '',
              activity: [],
            },
          },
        ),
      ),
    ).toMatchObject({
      title: 'creation task',
      summary: 'Claude Code · 结果待确认',
    })
  })

  it('subagent, jobs, workflow, ralph', () => {
    const running = tool(
      'subagent',
      { description: 'research', prompt: 'x' },
      undefined,
      {
        subagent: {
          subagentId: 's1',
          description: 'research',
          mode: 'spawn',
          background: true,
          status: 'running',
        },
      },
    )
    expect(row(running)).toMatchObject({
      title: 'research',
      summary: 'Emperor · 后台运行中',
      body: 'subagent',
    })
    expect(row(tool('subagent', {})).title).toBe('Emperor 子智能体')
    expect(
      row(
        tool(
          'subagent',
          { backend: 'codex', description: 'changed followup' },
          undefined,
          {
            externalAgent: {
              title: 'creation task',
              delegationId: 'dlg-one',
              runId: 'dgr-next',
              backend: 'codex',
              phase: 'waiting_input',
              text: '',
              activity: [],
            },
          },
        ),
      ),
    ).toMatchObject({ title: 'creation task', summary: 'Codex · 等待回答' })
    expect(subagentStatusLabel(running)).toBe('后台运行中')
    expect(row(tool('subagent_fork', { description: 'x' })).title).toBe('x')
    expect(
      row(
        tool(
          'job_output',
          { job_id: 'job-1', wait: true },
          {
            text: 'x\n[status: completed]',
            meta: { job: { status: 'completed' } },
          },
        ),
      ).summary,
    ).toBe('job-1 · 等待结束 · 已完成')
    expect(
      row(tool('job_list', {}, { text: '', meta: { jobs: [{}, {}] } })).summary,
    ).toBe('2 个任务')
    expect(
      row(
        tool('workflow', {
          meta: { name: 'review', description: 'Review all' },
          script: '',
        }),
      ),
    ).toMatchObject({
      title: '工作流',
      summary: 'review · Review all',
      body: 'workflow',
    })
    expect(
      row(tool('ralph', { objective: 'green tests', maxRounds: 3 })).summary,
    ).toBe('green tests · 最多 3 轮')
  })

  it('mcp_* resolves server and tool; unknown tools fall back', () => {
    const mcp = tool('mcp_github_list_issues', { repo: 'a/b' })
    expect(row(mcp)).toMatchObject({
      title: 'list_issues',
      summary: 'github · a/b',
      body: 'mcp',
    })
    expect(row(tool('mystery', { q: 'hello' }))).toMatchObject({
      title: 'mystery',
      summary: 'hello',
      body: 'generic',
    })
    for (const name of REGISTERED_TOOLS)
      expect(toolView(name).body).not.toBeUndefined()
  })
})

describe('tool model readers', () => {
  it('derives row state and error summaries', () => {
    expect(toolRowState(tool('read', {}))).toBe('running')
    expect(
      toolRowState(tool('read', {}, { text: 'x' }, { status: 'interrupted' })),
    ).toBe('stopped')
    const failed = tool(
      'read',
      {},
      { text: 'ENOENT: no such file\nat x', isError: true },
    )
    expect(toolRowState(failed)).toBe('error')
    expect(errorSummary(failed)).toBe('ENOENT: no such file')
    const exit = tool(
      'bash',
      { command: 'false' },
      {
        text: '(no output)\n[exit code: 1]',
        meta: { kind: 'foreground', exitCode: 1 },
      },
    )
    expect(toolRowState(exit)).toBe('error')
    expect(errorSummary(exit)).toBe('退出码 1')
  })

  it('strips shell markers from terminal output', () => {
    const data = tool(
      'bash',
      { command: 'x' },
      {
        text: 'hello\n[stderr]\nwarn\n[exit code: 2]',
        meta: { kind: 'foreground', exitCode: 2 },
      },
    )
    expect(shellOutcome(data)).toMatchObject({
      output: 'hello\n[stderr]\nwarn',
      exitCode: 2,
      background: false,
    })
  })

  it('parses the read envelope', () => {
    const data = tool(
      'read',
      { file_path: 'a.ts' },
      {
        text: '<path>a.ts</path>\n<type>file</type>\n<content>\n1: one\n2: \n3: three\n\n(End of file - total 3 lines)\n</content>',
        meta: { path: 'a.ts', startLine: 1, endLine: 3, totalLines: 3 },
      },
    )
    expect(readWindow(data)).toEqual({
      path: 'a.ts',
      totalLines: 3,
      lines: [
        { number: 1, text: 'one' },
        { number: 2, text: '' },
        { number: 3, text: 'three' },
      ],
    })
  })

  it('builds diff hunks for mutations', () => {
    expect(
      mutationHunks(
        tool('edit', { file_path: 'a', old_string: 'x', new_string: 'y' }),
      ),
    ).toEqual([{ path: 'a', oldText: 'x', newText: 'y' }])
    expect(
      mutationHunks(tool('write', { file_path: 'a', content: 'z' })),
    ).toEqual([{ path: 'a', oldText: null, newText: 'z' }])
    expect(
      hunksFromUnifiedDiff(
        '--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n keep\n-old\n+new',
        'f',
      ),
    ).toEqual([{ path: 'f', oldText: 'keep\nold\n', newText: 'keep\nnew\n' }])
  })
})
