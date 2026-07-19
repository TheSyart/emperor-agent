import { describe, expect, it } from 'vitest'
import { PromptPrefetchCoordinator } from './prefetch'

describe('PromptPrefetchCoordinator', () => {
  it('starts memory, skills, and MCP work concurrently and bounds optional latency', async () => {
    const started: string[] = []
    const coordinator = new PromptPrefetchCoordinator()
    const result = await coordinator.run(
      [
        {
          name: 'memory',
          run: async () => {
            started.push('memory')
            await Promise.resolve()
            return 'memory-v1'
          },
        },
        {
          name: 'skills',
          timeoutMs: 5,
          run: async (signal) => {
            started.push('skills')
            await new Promise<void>((resolve) => {
              signal.addEventListener('abort', () => resolve(), {
                once: true,
              })
            })
            return 'late-skills'
          },
        },
        {
          name: 'mcp',
          run: async () => {
            started.push('mcp')
            return ['filesystem']
          },
        },
      ],
      { deadlineMs: 50 },
    )

    expect(started).toEqual(['memory', 'skills', 'mcp'])
    expect(result.values).toEqual({
      memory: 'memory-v1',
      mcp: ['filesystem'],
    })
    expect(result.report.tasks).toEqual([
      expect.objectContaining({ name: 'memory', status: 'ready' }),
      expect.objectContaining({ name: 'skills', status: 'timeout' }),
      expect.objectContaining({ name: 'mcp', status: 'ready' }),
    ])
    expect(JSON.stringify(result.report)).not.toContain('late-skills')
  })

  it('fails closed when a required prefetch cannot complete', async () => {
    const coordinator = new PromptPrefetchCoordinator()

    await expect(
      coordinator.run(
        [
          {
            name: 'execution_environment',
            required: true,
            run: async () => {
              throw new Error('private host path')
            },
          },
          { name: 'mcp', run: async () => ['one'] },
        ],
        { deadlineMs: 50 },
      ),
    ).rejects.toMatchObject({
      name: 'PromptPrefetchError',
      code: 'prompt_prefetch_required_failed',
      taskName: 'execution_environment',
      report: {
        tasks: [
          expect.objectContaining({
            name: 'execution_environment',
            status: 'error',
            errorCode: 'prefetch_task_failed',
          }),
          expect.objectContaining({ name: 'mcp', status: 'ready' }),
        ],
      },
    })
  })

  it('propagates parent cancellation without waiting for task completion', async () => {
    const coordinator = new PromptPrefetchCoordinator()
    const controller = new AbortController()
    const pending = coordinator.run(
      [
        {
          name: 'memory',
          run: async () => new Promise<string>(() => undefined),
        },
      ],
      { signal: controller.signal, deadlineMs: 10_000 },
    )

    controller.abort(new Error('turn cancelled'))

    const result = await pending
    expect(result.report.tasks[0]).toMatchObject({
      name: 'memory',
      status: 'aborted',
      errorCode: 'prefetch_aborted',
    })
  })

  it('preserves a required source domain error with a stable public code', async () => {
    const coordinator = new PromptPrefetchCoordinator()
    const domainError = Object.assign(new Error('private detail'), {
      code: 'requested_skill_unavailable',
    })

    await expect(
      coordinator.run([
        {
          name: 'requested_skills',
          required: true,
          run: () => {
            throw domainError
          },
        },
      ]),
    ).rejects.toBe(domainError)
  })
})
