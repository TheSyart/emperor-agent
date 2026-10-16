// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ExecutorsSection from './ExecutorsSection.vue'
import { createSettingsHeader, SETTINGS_HEADER_KEY } from './settingsHeader'
const { listExecutors, configureExecutors, probeExecutor } = vi.hoisted(() => ({
  listExecutors: vi.fn(),
  configureExecutors: vi.fn(),
  probeExecutor: vi.fn(),
}))
vi.mock('../../api/delegations', () => ({
  listExecutors,
  configureExecutors,
  probeExecutor,
}))
const statuses = [
  'available',
  'missing',
  'needs_auth',
  'incompatible',
  'containment_unavailable',
]
function payload() {
  return {
    config: {
      schemaVersion: 1,
      revision: 7,
      profiles: statuses.map((_, i) => ({
        id: 'profile-' + i,
        backend: i % 2 ? 'codex' : 'claude-code',
        enabled: false,
        executablePath: i % 2 ? 'codex' : 'claude',
        expectedVersion: i % 2 ? '0.153.4' : '2.1.281',
        authRef: { kind: 'managed-cli-login' },
        stateDirectoryId: 'profile-' + i,
        concurrencyLimit: 1,
      })),
      limits: {
        globalConcurrency: 2,
        maxQueuedMessages: 16,
        maxRunsPerTask: 32,
        maxDepth: 3,
        runTimeoutMs: 1800000,
        questionTimeoutMs: 900000,
        estimatedBudgetUsd: 10,
      },
    },
    diagnostic: null,
    profiles: statuses.map((status, i) => ({
      profile: { id: 'profile-' + i },
      probe: { status, authVerified: false },
    })),
  }
}
let app: App | undefined,
  root: HTMLDivElement,
  header: ReturnType<typeof createSettingsHeader>
async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve()
  await nextTick()
}
async function mount() {
  root = document.createElement('div')
  document.body.append(root)
  app = createApp({ render: () => h(ExecutorsSection) })
  header = createSettingsHeader()
  app.provide(SETTINGS_HEADER_KEY, header)
  app.mount(root)
  await settle()
  return root
}
beforeEach(() => {
  listExecutors.mockResolvedValue(payload())
  configureExecutors.mockResolvedValue({ ...payload().config, revision: 8 })
  probeExecutor.mockResolvedValue({ status: 'available', authVerified: false })
})
afterEach(() => {
  app?.unmount()
  root?.remove()
  vi.clearAllMocks()
})
it('shows all five probe states and keeps authentication as references without a secret input', async () => {
  const dom = await mount()
  for (const label of [
    '可用',
    '未找到',
    '需要认证',
    '版本不兼容',
    '隔离不可用',
  ])
    expect(dom.textContent).toContain(label)
  expect(dom.querySelectorAll('input[type=password]')).toHaveLength(0)
  expect(dom.querySelectorAll('[data-executor-enabled]')).toHaveLength(5)
})
it('saves an explicit enable with revision and refreshes stale configuration without replaying the save', async () => {
  const dom = await mount(),
    toggle = dom.querySelector<HTMLButtonElement>('[data-executor-enabled]')!
  toggle.click()
  await settle()
  const save = () =>
    header.actions.value.find((action) => action.id === 'save-executors')!
      .onClick!()
  configureExecutors.mockRejectedValue(new Error('STALE_REVISION: changed'))
  void save()
  void save()
  await settle()
  expect(configureExecutors).toHaveBeenCalledTimes(1)
  expect(configureExecutors.mock.calls[0]?.[0]).toMatchObject({
    expectedRevision: 7,
    config: {
      profiles: [
        expect.objectContaining({ enabled: true }),
        ...payload().config.profiles.slice(1),
      ],
    },
  })
  expect(listExecutors).toHaveBeenCalledTimes(2)
  expect(dom.textContent).toContain('STALE_REVISION')
})
