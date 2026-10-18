import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultExecutorConfig } from './config'
import { ExecutorFactsStore } from './facts'
import type { ExecutorProfile, NormalizedExecutorEvent } from './types'
const roots: string[] = []
afterEach(() =>
  roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })),
)
function fixture(backend: 'codex' | 'claude-code' = 'codex') {
  const root = mkdtempSync(join(tmpdir(), 'emperor-facts-'))
  roots.push(root)
  const profile = defaultExecutorConfig().profiles.find(
    (p) => p.backend === backend,
  )!
  const store = new ExecutorFactsStore(root)
  const environment = {
    OPENAI_API_KEY: 'secret-key',
    ANTHROPIC_API_KEY: 'secret-key',
  }
  const context = {
    cwd: root,
    runId: 'dgr-test',
    delegationId: 'dlg-test',
    permissionMode: 'workspace-write' as const,
  }
  const emit = (payload: Record<string, unknown>) =>
    store.observe(profile, context, {
      ...context,
      generation: 1,
      ...payload,
    } as unknown as NormalizedExecutorEvent)
  store.bind(profile, environment)
  return { root, profile, store, environment, context, emit }
}
function metadata(f: ReturnType<typeof fixture>, model = 'actual-model') {
  f.emit({
    type: 'runtime_metadata',
    model,
    provider: 'provider.example',
    source: 'initialization',
    advertisedTools: ['WebSearch', 'WebFetch'],
    searchMode: 'live',
  })
}
function search(
  f: ReturnType<typeof fixture>,
  action: 'search' | 'fetch',
  success = true,
) {
  f.emit({
    type: 'tool_finished',
    id: action,
    status: success ? 'completed' : 'failed',
    evidence: {
      kind: 'search',
      action,
      success,
      references: success ? ['https://example.com/docs'] : [],
      searchMode: 'live',
    },
  })
}
it('never confuses readiness, advertised tools or text with working native capabilities', () => {
  const f = fixture()
  metadata(f)
  f.emit({
    type: 'text_delta',
    text: 'I searched and generated an image successfully',
  })
  expect(f.store.view(f.profile).nativeCapabilities.search.status).toBe(
    'unverified',
  )
  expect(
    f.store.view(f.profile).nativeCapabilities.imageGeneration.status,
  ).toBe('unverified')
  search(f, 'search')
  expect(f.store.view(f.profile).nativeCapabilities.search.status).toBe(
    'verifying',
  )
  search(f, 'fetch')
  expect(f.store.view(f.profile)).toMatchObject({
    reportedModel: 'actual-model',
    nativeCapabilities: {
      search: {
        status: 'available',
        runId: 'dgr-test',
        references: ['https://example.com/docs'],
      },
    },
  })
})
it('requires search and fetch in the same run and does not join unrelated results', () => {
  const f = fixture()
  metadata(f)
  search(f, 'search')
  f.store.observe(
    f.profile,
    { ...f.context, runId: 'dgr-other' },
    {
      ...f.context,
      runId: 'dgr-other',
      generation: 1,
      type: 'tool_finished',
      id: 'fetch',
      status: 'completed',
      evidence: {
        kind: 'search',
        action: 'fetch',
        success: true,
        references: ['https://example.com/docs'],
      },
    },
  )
  expect(f.store.view(f.profile).nativeCapabilities.search.status).not.toBe(
    'available',
  )
})
it('retains explicit native failure without turning it into success at turn completion', () => {
  const f = fixture()
  metadata(f)
  search(f, 'search', false)
  f.emit({ type: 'turn_finished', status: 'completed', text: 'all done' })
  expect(f.store.view(f.profile).nativeCapabilities.search.status).toBe(
    'unavailable',
  )
})
it('persists evidence, rechecks credential identity after restart, and ignores specialty-only edits', () => {
  const f = fixture()
  metadata(f)
  search(f, 'search')
  search(f, 'fetch')
  const restarted = new ExecutorFactsStore(f.root)
  expect(restarted.view(f.profile).nativeCapabilities.search.status).toBe(
    'stale',
  )
  restarted.bind(f.profile, f.environment)
  expect(
    restarted.view({ ...f.profile, specialties: ['custom'] }).nativeCapabilities
      .search.status,
  ).toBe('available')
  restarted.bind(f.profile, { ...f.environment, OPENAI_API_KEY: 'new-secret' })
  expect(restarted.view(f.profile).nativeCapabilities.search.status).toBe(
    'stale',
  )
  expect(readFileSync(restarted.file, 'utf8')).not.toContain('secret-key')
})
it.each(['defaultModel', 'expectedVersion', 'executablePath'] as const)(
  'invalidates proof when %s changes',
  (key) => {
    const f = fixture()
    metadata(f)
    search(f, 'search')
    search(f, 'fetch')
    const profile = { ...f.profile, [key]: 'changed' } as ExecutorProfile
    f.store.bind(profile, f.environment)
    expect(f.store.view(profile).nativeCapabilities.search.status).toBe('stale')
  },
)
it('invalidates old tool proof on provider-reported model change', () => {
  const f = fixture()
  metadata(f)
  search(f, 'search')
  search(f, 'fetch')
  metadata(f, 'different-model')
  expect(f.store.view(f.profile).nativeCapabilities.search.status).toBe('stale')
})
it('only records image capability after native success and a real scoped image exists', () => {
  const f = fixture()
  metadata(f)
  const event = {
    type: 'tool_finished',
    id: 'image',
    status: 'completed',
    evidence: {
      kind: 'image-generation',
      action: 'generate',
      success: true,
      artifactPath: join(f.root, 'image.png'),
    },
  }
  f.emit(event)
  expect(
    f.store.view(f.profile).nativeCapabilities.imageGeneration.status,
  ).toBe('unavailable')
  writeFileSync(
    join(f.root, 'image.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==',
      'base64',
    ),
  )
  f.emit(event)
  expect(
    f.store.view(f.profile).nativeCapabilities.imageGeneration,
  ).toMatchObject({ status: 'available', runId: 'dgr-test' })
})
it('rejects external image paths and never treats a script file as a native image', () => {
  const f = fixture()
  metadata(f)
  const other = mkdtempSync(join(tmpdir(), 'emperor-foreign-'))
  roots.push(other)
  writeFileSync(join(other, 'a.png'), Buffer.alloc(60))
  f.emit({
    type: 'tool_finished',
    id: 'image',
    status: 'completed',
    evidence: {
      kind: 'image-generation',
      action: 'generate',
      success: true,
      artifactPath: join(other, 'a.png'),
    },
  })
  expect(
    f.store.view(f.profile).nativeCapabilities.imageGeneration.status,
  ).toBe('unavailable')
})
it('records Claude image generation as unsupported by the host tool policy, not by a model claim', () => {
  const f = fixture('claude-code')
  metadata(f)
  expect(
    f.store.view(f.profile).nativeCapabilities.imageGeneration.status,
  ).toBe('unsupported')
  expect(f.store.view(f.profile).hostAllowedTools).toContain('WebSearch')
})
it('keeps an unknown model unknown and refuses to leak credentials in references', () => {
  const f = fixture()
  f.emit({
    type: 'runtime_metadata',
    source: 'initialization',
    advertisedTools: [],
  })
  search(f, 'search')
  search(f, 'fetch')
  expect(f.store.view(f.profile).reportedModel).toBeNull()
  f.emit({
    type: 'tool_finished',
    id: 'bad',
    status: 'completed',
    evidence: {
      kind: 'search',
      action: 'fetch',
      success: true,
      references: ['https://user:password@example.com/doc?token=secret-key'],
    },
  })
  expect(readFileSync(f.store.file, 'utf8')).not.toMatch(/password|secret-key/)
})
it('preserves damaged evidence rather than manufacturing available facts', () => {
  const f = fixture()
  writeFileSync(f.store.file, 'broken')
  const restarted = new ExecutorFactsStore(f.root)
  restarted.bind(f.profile, f.environment)
  expect(restarted.view(f.profile).nativeCapabilities.search.status).toBe(
    'unverified',
  )
  expect(readFileSync(f.store.file, 'utf8')).toBe('broken')
})
it('invalidates positive evidence when the executor becomes unavailable', () => {
  const f = fixture()
  metadata(f)
  search(f, 'search')
  search(f, 'fetch')
  f.store.setProbe(f.profile, {
    status: 'needs_auth',
    checkedAt: Date.now(),
    authVerified: false,
    capabilities: {} as any,
  })
  expect(f.store.view(f.profile).nativeCapabilities.search.status).toBe('stale')
})
it('invalidates Claude OAuth login changes and rejects superficially labelled PNG files', () => {
  const f = fixture('claude-code')
  f.store.bind(f.profile, { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-account-a' })
  metadata(f)
  search(f, 'search')
  search(f, 'fetch')
  f.store.bind(f.profile, { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-account-b' })
  expect(f.store.view(f.profile).nativeCapabilities.search.status).toBe('stale')
  const codex = fixture()
  metadata(codex)
  const path = join(codex.root, 'fake.png'),
    b = Buffer.alloc(33)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b)
  b.writeUInt32BE(10, 16)
  b.writeUInt32BE(10, 20)
  writeFileSync(path, b)
  codex.emit({
    type: 'tool_finished',
    id: 'i',
    status: 'completed',
    evidence: {
      kind: 'image-generation',
      action: 'generate',
      success: true,
      artifactPath: path,
    },
  })
  expect(
    codex.store.view(codex.profile).nativeCapabilities.imageGeneration.status,
  ).not.toBe('available')
})
it('never attributes a concurrent run result to another reported model or newer account', () => {
  const f = fixture()
  metadata(f, 'model-a')
  search(f, 'search')
  const other = { ...f.context, runId: 'dgr-new' }
  f.store.observe(f.profile, other, {
    ...other,
    generation: 1,
    type: 'runtime_metadata',
    source: 'provider-response',
    model: 'model-b',
  })
  search(f, 'fetch')
  expect(f.store.view(f.profile).nativeCapabilities.search.status).not.toBe(
    'available',
  )
  f.store.bind(f.profile, { OPENAI_API_KEY: 'new-account' }, 'dgr-new')
  f.store.observe(f.profile, other, {
    ...other,
    generation: 1,
    type: 'runtime_metadata',
    source: 'provider-response',
    model: 'model-b',
  })
  metadata(f, 'model-a')
  search(f, 'search')
  search(f, 'fetch')
  expect(f.store.view(f.profile).nativeCapabilities.search.status).not.toBe(
    'available',
  )
})

it('retains non-secret execution provenance with capability evidence', () => {
  const f = fixture()
  metadata(f)
  search(f, 'search')
  search(f, 'fetch')
  expect(f.store.view(f.profile).nativeCapabilities.search).toMatchObject({
    backend: 'codex',
    executorVersion: f.profile.expectedVersion,
    adapterVersion: 'native-facts-v2',
    toolPolicy: 'native-tools-v2-structured-results',
    permissionMode: 'workspace-write',
    authIdentity: expect.stringMatching(/^[a-f0-9]{12}$/),
  })
})
