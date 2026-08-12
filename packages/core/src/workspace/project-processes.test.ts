import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { OwnedProcessHandle } from '../processes/runtime'
import {
  ProjectProcessError,
  ProjectProcessService,
  type ProjectProcessServiceOptions,
} from './project-processes'
import { WebsitePreviewRegistry } from './website-previews'

function fixture(overrides: Partial<ProjectProcessServiceOptions> = {}) {
  const stateRoot = mkdtempSync(
    join(tmpdir(), 'emperor-project-process-state-'),
  )
  const projectRoot = mkdtempSync(
    join(tmpdir(), 'emperor-project-process-root-'),
  )
  writeFileSync(join(projectRoot, 'index.html'), '<h1>Hello</h1>\n')
  const close = vi.fn(async () => undefined)
  const emit = vi.fn(async () => undefined)
  const service = new ProjectProcessService({
    stateRoot,
    resolveProjectRoot: (sessionId) => {
      if (sessionId !== 'session-1' && sessionId !== 'session-2')
        throw new Error('unknown session')
      return projectRoot
    },
    resolveEnvironment: async () => ({ toolPaths: {}, env: {} }),
    previewRegistry: new WebsitePreviewRegistry({ probe: async () => true }),
    allocatePort: async () => 43121,
    startStaticHost: async ({ port }) => ({
      url: `http://127.0.0.1:${port}/`,
      close,
    }),
    emit,
    ...overrides,
  })
  return { service, projectRoot, stateRoot, close, emit }
}

describe('ProjectProcessService', () => {
  it('exposes stable safe errors without internal details', () => {
    const error = new ProjectProcessError(
      'project_process_owner_invalid',
      'Project process does not belong to this session.',
    )

    expect(error.toSafe()).toEqual({
      code: 'project_process_owner_invalid',
      message: 'Project process does not belong to this session.',
    })
    expect(JSON.stringify(error.toSafe())).not.toMatch(/stack|cause/)
  })

  it('starts a static candidate idempotently and registers a ready preview', async () => {
    const { service, close, emit } = fixture()
    const [candidate] = await service.candidates('session-1')

    const first = await service.start({
      sessionId: 'session-1',
      candidateId: candidate!.id,
      invocationId: 'invoke-static-1',
    })
    const second = await service.start({
      sessionId: 'session-1',
      candidateId: candidate!.id,
      invocationId: 'invoke-static-1',
    })

    expect(second.id).toBe(first.id)
    expect(first).toMatchObject({
      sessionId: 'session-1',
      ecosystem: 'static',
      status: 'running',
      health: 'ready',
      primary: true,
    })
    expect(first.preview).toMatchObject({ status: 'ready' })
    expect(close).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ event: 'project_process_update' }),
    )
  })

  it('rejects forged candidate ids without starting anything', async () => {
    const { service } = fixture()
    await expect(
      service.start({
        sessionId: 'session-1',
        candidateId: 'launch_000000000000000000000000',
        invocationId: 'invoke-forged',
      }),
    ).rejects.toMatchObject({ code: 'project_process_candidate_invalid' })
    expect(service.list('session-1')).toEqual([])
  })

  it('enforces four active processes per session but isolates different sessions', async () => {
    let port = 43120
    const { service } = fixture({ allocatePort: async () => ++port })
    const [candidate] = await service.candidates('session-1')
    for (let index = 0; index < 4; index += 1)
      await service.start({
        sessionId: 'session-1',
        candidateId: candidate!.id,
        invocationId: `invoke-${index}`,
      })

    await expect(
      service.start({
        sessionId: 'session-1',
        candidateId: candidate!.id,
        invocationId: 'invoke-over-limit',
      }),
    ).rejects.toMatchObject({ code: 'project_process_limit' })

    const [otherCandidate] = await service.candidates('session-2')
    await expect(
      service.start({
        sessionId: 'session-2',
        candidateId: otherCandidate!.id,
        invocationId: 'invoke-other-session',
      }),
    ).resolves.toMatchObject({ sessionId: 'session-2' })
  })

  it('requires owner and revision to stop, then makes its preview stale', async () => {
    const { service, close } = fixture()
    const [candidate] = await service.candidates('session-1')
    const process = await service.start({
      sessionId: 'session-1',
      candidateId: candidate!.id,
      invocationId: 'invoke-stop',
    })

    await expect(
      service.stop({
        sessionId: 'session-2',
        processId: process.id,
        expectedRevision: process.revision,
      }),
    ).rejects.toBeInstanceOf(ProjectProcessError)
    await expect(
      service.stop({
        sessionId: 'session-1',
        processId: process.id,
        expectedRevision: process.revision + 1,
      }),
    ).rejects.toMatchObject({ code: 'project_process_stale' })

    const stopped = await service.stop({
      sessionId: 'session-1',
      processId: process.id,
      expectedRevision: process.revision,
    })
    expect(stopped).toMatchObject({ status: 'stopped', health: 'stopped' })
    expect(stopped.preview).toMatchObject({ status: 'stopped' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('stops all owner processes when the session is cleared or deleted', async () => {
    const { service, close } = fixture()
    const [candidate] = await service.candidates('session-1')
    await service.start({
      sessionId: 'session-1',
      candidateId: candidate!.id,
      invocationId: 'invoke-clear-1',
    })
    await service.start({
      sessionId: 'session-1',
      candidateId: candidate!.id,
      invocationId: 'invoke-clear-2',
    })

    const stopped = await service.stopSession('session-1', 'session cleared')
    expect(stopped).toHaveLength(2)
    expect(close).toHaveBeenCalledTimes(2)
    expect(
      service.list('session-1').every((item) => item.status === 'stopped'),
    ).toBe(true)
  })

  it('captures bounded child-process output and never exposes argv or environment', async () => {
    const stateRoot = mkdtempSync(
      join(tmpdir(), 'emperor-project-process-node-'),
    )
    const projectRoot = mkdtempSync(
      join(tmpdir(), 'emperor-project-process-node-root-'),
    )
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({ scripts: { dev: 'vite' } }),
    )
    writeFileSync(join(projectRoot, 'package-lock.json'), '{}')
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    let settle!: (value: never) => void
    const settled = new Promise<never>((resolve) => {
      settle = resolve
    })
    const cancel = vi.fn(() => settle({ status: 'cancelled' } as never))
    const emit = vi.fn<
      (sessionId: string, event: Record<string, unknown>) => Promise<void>
    >(async () => undefined)
    const handle = {
      processId: 'owned-process-1',
      leaseId: 'lease-1',
      pid: 123,
      stdin: new PassThrough(),
      stdout,
      stderr,
      settled,
      receipt: () => ({}) as never,
      cancel,
    } satisfies OwnedProcessHandle
    const service = new ProjectProcessService({
      stateRoot,
      resolveProjectRoot: () => projectRoot,
      resolveEnvironment: async () => ({
        toolPaths: { npm: '/signed/npm' },
        env: { PATH: '/signed' },
      }),
      processRuntime: { spawn: vi.fn(async () => handle) },
      previewRegistry: new WebsitePreviewRegistry({ probe: async () => false }),
      allocatePort: async () => 43125,
      previewProbeDelaysMs: [0],
      emit,
    })
    const [candidate] = await service.candidates('session-1')
    const started = await service.start({
      sessionId: 'session-1',
      candidateId: candidate!.id,
      invocationId: 'invoke-node',
    })
    stdout.write('ready at http://127.0.0.1:43125/\n')
    stderr.write(
      'safe diagnostic Authorization: Bearer exposed-token https://example.test/?access_token=query-secret token=assignment-secret\n',
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    const output = service.readOutput({
      sessionId: 'session-1',
      processId: started.id,
      afterSeq: 0,
    })
    const outputText = output.chunks.map((chunk) => chunk.data).join('')
    expect(outputText).toContain('safe diagnostic')
    expect(outputText).not.toMatch(
      /exposed-token|query-secret|assignment-secret/,
    )
    expect(outputText).toContain('[redacted]')
    expect(JSON.stringify(service.list('session-1'))).not.toMatch(
      /\/signed\/npm|"PATH"/,
    )
    await service.stop({
      sessionId: 'session-1',
      processId: started.id,
      expectedRevision: started.revision,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(
      emit.mock.calls.some(
        ([, event]) =>
          event.event === 'project_process_update' &&
          (event.process as { status?: string } | undefined)?.status ===
            'failed',
      ),
    ).toBe(false)
  })

  it('waits for a bounded health probe before returning a ready process receipt', async () => {
    const stateRoot = mkdtempSync(
      join(tmpdir(), 'emperor-project-process-health-'),
    )
    const projectRoot = mkdtempSync(
      join(tmpdir(), 'emperor-project-process-health-root-'),
    )
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({ scripts: { dev: 'vite' } }),
    )
    writeFileSync(join(projectRoot, 'package-lock.json'), '{}')
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const handle = {
      processId: 'owned-process-health',
      leaseId: 'lease-health',
      pid: 456,
      stdin: new PassThrough(),
      stdout,
      stderr,
      settled: new Promise<never>(() => undefined),
      receipt: () => ({}) as never,
      cancel: vi.fn(),
    } satisfies OwnedProcessHandle
    const probe = vi
      .fn<(url: string) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const service = new ProjectProcessService({
      stateRoot,
      resolveProjectRoot: () => projectRoot,
      resolveEnvironment: async () => ({
        toolPaths: { npm: '/signed/npm' },
        env: { PATH: '/signed' },
      }),
      processRuntime: { spawn: vi.fn(async () => handle) },
      previewRegistry: new WebsitePreviewRegistry({ probe }),
      allocatePort: async () => 43126,
      previewProbeDelaysMs: [0, 0],
    })
    const [candidate] = await service.candidates('session-1')

    const started = await service.start({
      sessionId: 'session-1',
      candidateId: candidate!.id,
      invocationId: 'invoke-health',
    })

    expect(probe).toHaveBeenCalledTimes(2)
    expect(started).toMatchObject({
      status: 'running',
      health: 'ready',
      preview: { status: 'ready' },
    })
  })
})
