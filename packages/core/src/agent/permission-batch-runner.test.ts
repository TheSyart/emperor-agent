import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ControlManager } from '../control/manager'
import { TurnPaused } from '../control/exceptions'
import { ControlMode } from '../control/models'
import { LLMProvider, type ChatArgs, type LLMResponse } from '../providers/base'
import { DeleteFileTool } from '../tools/filesystem'
import { ToolRegistry } from '../tools/registry'
import { AgentRunner } from './runner'

class SequenceProvider extends LLMProvider {
  constructor(private readonly responses: LLMResponse[]) {
    super({ defaultModel: 'fake' })
  }

  async chat(_args: ChatArgs): Promise<LLMResponse> {
    const response = this.responses.shift()
    if (!response) throw new Error('missing response')
    return response
  }
}

function response(content: string | null, paths: string[] = []): LLMResponse {
  return {
    content,
    toolCalls: paths.map((path, index) => ({
      id: `delete_${index + 1}`,
      name: 'delete_file',
      arguments: { path },
    })),
    finishReason: paths.length ? 'tool_calls' : 'stop',
    usage: {},
    reasoningContent: null,
    thinkingBlocks: null,
  }
}

describe('AgentRunner permission batch preflight', () => {
  it('pauses three destructive calls behind one exact request and executes once after approval', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'emperor-batch-workspace-'))
    const stateRoot = mkdtempSync(join(tmpdir(), 'emperor-batch-state-'))
    const paths = ['a.txt', 'b.txt', 'c.txt']
    for (const path of paths) writeFileSync(join(workspace, path), path)

    const control = new ControlManager(stateRoot)
    const registry = new ToolRegistry(workspace)
    registry.register(new DeleteFileTool(workspace))
    const provider = new SequenceProvider([
      response(null, paths),
      response(null, paths),
      response('done'),
    ])
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry,
      systemPrompt: 'system',
      controlManager: control,
      workspaceRoot: workspace,
      sessionId: 'session_permission_batch',
    })
    const history: Array<Record<string, unknown>> = [
      { role: 'user', content: '全部删除' },
    ]

    let pause: TurnPaused | null = null
    try {
      await runner.stepAsync(history)
    } catch (error) {
      if (error instanceof TurnPaused) pause = error
      else throw error
    }
    expect(pause).not.toBeNull()
    expect(paths.every((path) => existsSync(join(workspace, path)))).toBe(true)
    const pending = control.payload().pending
    expect(pending).not.toBeNull()
    if (!pending) throw new Error('missing pending permission interaction')
    expect(pending.meta.permission).toMatchObject({
      version: 2,
      operation_count: 3,
    })

    const resumed = control.answer(pending.id, {
      permission: { option_id: 'allow_once', choice: '允许本次' },
    })
    history.push({ role: 'user', content: resumed.message })

    await expect(runner.stepAsync(history)).resolves.toBe('done')
    expect(paths.every((path) => !existsSync(join(workspace, path)))).toBe(true)
  })

  it('uses one permission request for the same destructive batch in smart_auto', async () => {
    const workspace = mkdtempSync(
      join(tmpdir(), 'emperor-smart-batch-workspace-'),
    )
    const stateRoot = mkdtempSync(join(tmpdir(), 'emperor-smart-batch-state-'))
    const paths = ['a.txt', 'b.txt', 'c.txt']
    for (const path of paths) writeFileSync(join(workspace, path), path)
    const control = new ControlManager(stateRoot)
    control.setMode(ControlMode.SMART_AUTO)
    const registry = new ToolRegistry(workspace)
    registry.register(new DeleteFileTool(workspace))
    const runner = new AgentRunner({
      provider: new SequenceProvider([response(null, paths)]),
      model: 'fake',
      registry,
      systemPrompt: 'system',
      controlManager: control,
      workspaceRoot: workspace,
      sessionId: 'session_smart_permission_batch',
    })

    await expect(
      runner.stepAsync([{ role: 'user', content: '全部删除' }]),
    ).rejects.toBeInstanceOf(TurnPaused)
    expect(control.payload().pending?.meta.permission).toMatchObject({
      version: 2,
      operation_count: 3,
    })
    expect(paths.every((path) => existsSync(join(workspace, path)))).toBe(true)
  })

  it('executes the destructive batch directly in full_access', async () => {
    const workspace = mkdtempSync(
      join(tmpdir(), 'emperor-full-batch-workspace-'),
    )
    const stateRoot = mkdtempSync(join(tmpdir(), 'emperor-full-batch-state-'))
    const paths = ['a.txt', 'b.txt', 'c.txt']
    for (const path of paths) writeFileSync(join(workspace, path), path)
    const control = new ControlManager(stateRoot)
    control.setMode(ControlMode.FULL_ACCESS)
    const registry = new ToolRegistry(workspace)
    registry.register(new DeleteFileTool(workspace))
    const runner = new AgentRunner({
      provider: new SequenceProvider([response(null, paths), response('done')]),
      model: 'fake',
      registry,
      systemPrompt: 'system',
      controlManager: control,
      workspaceRoot: workspace,
      sessionId: 'session_full_permission_batch',
    })

    await expect(
      runner.stepAsync([{ role: 'user', content: '全部删除' }]),
    ).resolves.toBe('done')
    expect(control.payload().pending).toBeNull()
    expect(paths.every((path) => !existsSync(join(workspace, path)))).toBe(true)
  })

  it('denies the resumed exact batch without deleting or asking again', async () => {
    const workspace = mkdtempSync(
      join(tmpdir(), 'emperor-deny-batch-workspace-'),
    )
    const stateRoot = mkdtempSync(join(tmpdir(), 'emperor-deny-batch-state-'))
    const paths = ['a.txt', 'b.txt', 'c.txt']
    for (const path of paths) writeFileSync(join(workspace, path), path)
    const control = new ControlManager(stateRoot)
    const registry = new ToolRegistry(workspace)
    registry.register(new DeleteFileTool(workspace))
    const provider = new SequenceProvider([
      response(null, paths),
      response(null, paths),
      response('done'),
    ])
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry,
      systemPrompt: 'system',
      controlManager: control,
      workspaceRoot: workspace,
      sessionId: 'session_denied_permission_batch',
    })
    const history: Array<Record<string, unknown>> = [
      { role: 'user', content: '全部删除' },
    ]
    await expect(runner.stepAsync(history)).rejects.toBeInstanceOf(TurnPaused)
    const pending = control.payload().pending!
    const resumed = control.answer(pending.id, {
      permission: { option_id: 'deny', choice: '拒绝' },
    })
    history.push({ role: 'user', content: resumed.message })

    await expect(runner.stepAsync(history)).resolves.toBe('done')
    expect(control.payload().pending).toBeNull()
    expect(paths.every((path) => existsSync(join(workspace, path)))).toBe(true)
  })

  it('does not carry an unused permission receipt across a newer user task', async () => {
    const workspace = mkdtempSync(
      join(tmpdir(), 'emperor-stale-batch-workspace-'),
    )
    const stateRoot = mkdtempSync(join(tmpdir(), 'emperor-stale-batch-state-'))
    const paths = ['a.txt', 'b.txt', 'c.txt']
    for (const path of paths) writeFileSync(join(workspace, path), path)
    const control = new ControlManager(stateRoot)
    const registry = new ToolRegistry(workspace)
    registry.register(new DeleteFileTool(workspace))
    const runner = new AgentRunner({
      provider: new SequenceProvider([
        response(null, paths),
        response(null, paths),
      ]),
      model: 'fake',
      registry,
      systemPrompt: 'system',
      controlManager: control,
      workspaceRoot: workspace,
      sessionId: 'session_stale_permission_batch',
    })
    const history: Array<Record<string, unknown>> = [
      { role: 'user', content: '全部删除' },
    ]
    await expect(runner.stepAsync(history)).rejects.toBeInstanceOf(TurnPaused)
    const firstPending = control.payload().pending!
    const resumed = control.answer(firstPending.id, {
      permission: { option_id: 'allow_once', choice: '允许本次' },
    })
    history.push({ role: 'user', content: resumed.message })
    history.push({ role: 'user', content: '这是一个新的普通用户任务' })

    await expect(runner.stepAsync(history)).rejects.toBeInstanceOf(TurnPaused)
    expect(control.payload().pending?.id).not.toBe(firstPending.id)
    expect(paths.every((path) => existsSync(join(workspace, path)))).toBe(true)
  })

  it('executes no batch side effects when any call fails schema preflight', async () => {
    const workspace = mkdtempSync(
      join(tmpdir(), 'emperor-invalid-batch-workspace-'),
    )
    const stateRoot = mkdtempSync(
      join(tmpdir(), 'emperor-invalid-batch-state-'),
    )
    writeFileSync(join(workspace, 'keep.txt'), 'keep')
    const control = new ControlManager(stateRoot)
    control.setMode(ControlMode.FULL_ACCESS)
    const registry = new ToolRegistry(workspace)
    registry.register(new DeleteFileTool(workspace))
    const invalidBatch = response(null, ['keep.txt'])
    invalidBatch.toolCalls.push({
      id: 'delete_invalid',
      name: 'delete_file',
      arguments: {},
    })
    const runner = new AgentRunner({
      provider: new SequenceProvider([invalidBatch, response('done')]),
      model: 'fake',
      registry,
      systemPrompt: 'system',
      controlManager: control,
      workspaceRoot: workspace,
      sessionId: 'session_invalid_permission_batch',
    })
    const history: Array<Record<string, unknown>> = [
      { role: 'user', content: '执行批次' },
    ]

    await expect(runner.stepAsync(history)).resolves.toBe('done')
    expect(existsSync(join(workspace, 'keep.txt'))).toBe(true)
    const toolMessages = history.filter((message) => message.role === 'tool')
    expect(toolMessages).toHaveLength(2)
    expect(
      toolMessages.every((message) =>
        String(message.content).startsWith('Error:'),
      ),
    ).toBe(true)
  })
})
