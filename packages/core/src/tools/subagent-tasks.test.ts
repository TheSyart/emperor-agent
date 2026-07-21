import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TaskManager } from '../tasks/manager'
import { TaskRuntimeRegistry } from '../tasks/runtime'
import {
  SubagentSupervisor,
  type SubagentLaunchResult,
} from '../subagents/supervisor'
import { SubagentTaskControlTool } from './subagent-tasks'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('SubagentTaskControlTool', () => {
  it('lets only the owner session poll/read/cancel/resume background work', async () => {
    const root = tmp('emperor-subagent-control-tool-')
    const manager = new TaskManager(root)
    const runtime = new TaskRuntimeRegistry(manager)
    const supervisor = new SubagentSupervisor(manager, runtime)
    const launch = async (
      resumedFromTaskId: string | null = null,
    ): Promise<SubagentLaunchResult<string>> =>
      await supervisor.launch({
        title: 'background research',
        sessionId: 'session_owner',
        agentType: 'sili_suitang',
        agentId: resumedFromTaskId ? 'agent_resumed' : 'agent_initial',
        turnId: resumedFromTaskId ? 'turn_resumed' : 'turn_initial',
        parentDepth: 0,
        mode: 'background',
        workspace: { mode: 'shared', root },
        metadata: {},
        ...(resumedFromTaskId ? { resumedFromTaskId } : {}),
        execute: resumedFromTaskId
          ? async () => 'resumed result'
          : async ({ signal, appendOutput }) => {
              appendOutput('partial output')
              return await new Promise<string>((_resolve, reject) => {
                signal.addEventListener(
                  'abort',
                  () => reject(new Error('cancel observed')),
                  { once: true },
                )
              })
            },
        resume: async (source) => await launch(source.id),
      })
    const initial = await launch()
    const tool = new SubagentTaskControlTool(supervisor)
    const ownerContext = {
      root,
      arguments: {},
      sessionId: 'session_owner',
    }

    await expect(
      tool.execute(
        { action: 'wait', task_id: initial.task.id, timeout_ms: 0 },
        ownerContext,
      ),
    ).resolves.toContain('"status":"running"')
    await expect(
      tool.execute(
        { action: 'read_output', task_id: initial.task.id },
        ownerContext,
      ),
    ).resolves.toContain('partial output')
    await expect(
      tool.execute(
        { action: 'cancel', task_id: initial.task.id, reason: 'operator stop' },
        { ...ownerContext, sessionId: 'session_other' },
      ),
    ).rejects.toMatchObject({ code: 'subagent_session_mismatch' })
    await expect(
      tool.execute(
        { action: 'cancel', task_id: initial.task.id, reason: 'operator stop' },
        ownerContext,
      ),
    ).resolves.toContain('"status":"cancelled"')
    await expect(
      tool.execute({ action: 'wait', task_id: initial.task.id }, ownerContext),
    ).resolves.toContain('operator stop')

    const resumedText = await tool.execute(
      { action: 'resume', task_id: initial.task.id },
      ownerContext,
    )
    const resumed = JSON.parse(resumedText) as { taskId: string }
    await expect(
      tool.execute(
        { action: 'wait', task_id: resumed.taskId, timeout_ms: 100 },
        ownerContext,
      ),
    ).resolves.toContain('"status":"completed"')
  })
})
