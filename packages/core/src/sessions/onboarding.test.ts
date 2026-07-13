import { describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentLoop } from '../agent/loop'
import { LLMProvider, type ChatArgs, type LLMResponse } from '../providers/base'
import type { ModelRoute, ProviderSnapshot } from '../model/router'
import {
  ProfileOnboardingCoordinator,
  claimProfileOnboardingTrigger,
  ensureUserProfileFile,
  isUserProfileStillDefault,
} from './onboarding'

const TEMPLATES_DIR = join(__dirname, '..', '..', '..', '..', 'templates')

class AskingFakeProvider extends LLMProvider {
  calls: ChatArgs[] = []
  constructor() {
    super({ defaultModel: 'fake-main' })
  }
  async chat(args: ChatArgs): Promise<LLMResponse> {
    this.calls.push(args)
    if (this.calls.length === 1) {
      return {
        content:
          '初次见面。我会根据个人偏好模板逐步了解你，并按你的回答决定是否继续追问。',
        toolCalls: [
          {
            id: 'call_ask',
            name: 'ask_user',
            arguments: {
              questions: [
                {
                  id: 'dynamic_priority',
                  header: '优先了解',
                  question: '你希望我先了解哪一类偏好？',
                  options: [
                    { label: '沟通方式', description: '先确定回复习惯' },
                    { label: '工作背景', description: '先了解工作上下文' },
                  ],
                },
              ],
            },
          },
        ],
        finishReason: 'tool_calls',
        usage: { input: 1, output: 1 },
        reasoningContent: null,
        thinkingBlocks: null,
      }
    }
    return {
      content: '好的。',
      toolCalls: [],
      finishReason: 'stop',
      usage: { input: 1, output: 1 },
      reasoningContent: null,
      thinkingBlocks: null,
    }
  }
}

function fakeRouter(provider: LLMProvider) {
  const snap: ProviderSnapshot = {
    provider,
    providerName: 'fake',
    providerLabel: 'Fake',
    model: 'fake-main',
    apiBase: null,
    generation: { maxTokens: 2000, temperature: 0.1, reasoningEffort: null },
    contextWindowTokens: 100_000,
    config: {},
    supportsVision: false,
    entryName: 'fake',
    entryLabel: 'Fake',
    modelRole: 'main',
    routeReason: 'fake',
  }
  return {
    route: (useCase: string): ModelRoute => ({
      snapshot: snap,
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

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function seedTemplatesDir(root: string, seedContent: string): string {
  const templatesDir = join(root, 'repo-templates')
  mkdirSync(join(templatesDir, 'init'), { recursive: true })
  writeFileSync(join(templatesDir, 'init', 'USER.md'), seedContent, 'utf8')
  return templatesDir
}

const SEED = '# 用户档案\n\n- **称呼**：未设置\n'

describe('ensureUserProfileFile (single-sourced seeding)', () => {
  it('seeds USER.local.md from the repo seed template when missing', () => {
    const stateRoot = tmp('emperor-onboarding-seed-')
    const templatesDir = seedTemplatesDir(stateRoot, SEED)

    const path = ensureUserProfileFile(stateRoot, templatesDir)

    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(SEED)
  })

  it('does not overwrite an existing local profile', () => {
    const stateRoot = tmp('emperor-onboarding-seed-existing-')
    const templatesDir = seedTemplatesDir(stateRoot, SEED)
    mkdirSync(join(stateRoot, 'memory', 'profile'), { recursive: true })
    writeFileSync(
      join(stateRoot, 'memory', 'profile', 'USER.local.md'),
      '# customized\n',
      'utf8',
    )

    const path = ensureUserProfileFile(stateRoot, templatesDir)

    expect(readFileSync(path, 'utf8')).toBe('# customized\n')
  })

  it('falls back to a minimal stub when the seed template is missing', () => {
    const stateRoot = tmp('emperor-onboarding-seed-fallback-')
    const templatesDir = join(stateRoot, 'no-such-dir')

    const path = ensureUserProfileFile(stateRoot, templatesDir)

    expect(readFileSync(path, 'utf8')).toBe('# 用户偏好\n\n')
  })
})

describe('isUserProfileStillDefault', () => {
  it('matches when content is byte-identical to the seed after trimming', () => {
    expect(isUserProfileStillDefault(SEED, SEED)).toBe(true)
    expect(isUserProfileStillDefault(`${SEED}\n\n`, SEED)).toBe(true)
  })

  it('does not match once the user has customized any content', () => {
    expect(
      isUserProfileStillDefault('# 用户档案\n\n- **称呼**：李公公\n', SEED),
    ).toBe(false)
  })
})

describe('ProfileOnboardingCoordinator', () => {
  it('creates pending state for a fresh default profile and gates auto attempts per process', () => {
    const stateRoot = tmp('emperor-onboarding-state-fresh-')
    const templatesDir = seedTemplatesDir(stateRoot, SEED)
    const userFile = ensureUserProfileFile(stateRoot, templatesDir)
    const coordinator = new ProfileOnboardingCoordinator({
      stateRoot,
      templatesDir,
      userFile,
    })

    expect(coordinator.payload()).toMatchObject({
      status: 'pending',
      attemptCount: 0,
      canStart: true,
      canSkip: true,
    })
    expect(coordinator.beginAttempt('chat-session', { manual: false })).toEqual(
      expect.objectContaining({ started: true }),
    )
    coordinator.fail(new Error(`provider failed at ${stateRoot}/secret`))

    expect(coordinator.payload()).toMatchObject({
      status: 'pending',
      attemptCount: 1,
      lastError: 'provider failed at <stateRoot>/secret',
    })
    expect(coordinator.beginAttempt('chat-session', { manual: false })).toEqual(
      expect.objectContaining({ started: false }),
    )
    expect(coordinator.beginAttempt('chat-session', { manual: true })).toEqual(
      expect.objectContaining({ started: true }),
    )
  })

  it('migrates the legacy latch without losing an unfinished default profile', () => {
    const stateRoot = tmp('emperor-onboarding-state-legacy-')
    const templatesDir = seedTemplatesDir(stateRoot, SEED)
    const userFile = ensureUserProfileFile(stateRoot, templatesDir)
    writeFileSync(
      join(stateRoot, 'onboarding.json'),
      JSON.stringify({ profileInterviewTriggeredAt: 123 }),
      'utf8',
    )

    const coordinator = new ProfileOnboardingCoordinator({
      stateRoot,
      templatesDir,
      userFile,
    })

    expect(coordinator.payload().status).toBe('pending')
    expect(
      JSON.parse(readFileSync(join(stateRoot, 'onboarding.json'), 'utf8')),
    ).toMatchObject({ version: 2, profile: { status: 'pending' } })
  })

  it('recovers stale in-progress state, defers cancellation, and persists skip', () => {
    const stateRoot = tmp('emperor-onboarding-state-recovery-')
    const templatesDir = seedTemplatesDir(stateRoot, SEED)
    const userFile = ensureUserProfileFile(stateRoot, templatesDir)
    const first = new ProfileOnboardingCoordinator({
      stateRoot,
      templatesDir,
      userFile,
    })
    first.beginAttempt('chat-session', { manual: false })
    first.attachInteraction('ask_profile')

    const restarted = new ProfileOnboardingCoordinator({
      stateRoot,
      templatesDir,
      userFile,
    })
    restarted.reconcilePendingInteraction(null)
    expect(restarted.payload()).toMatchObject({
      status: 'pending',
      sessionId: null,
      interactionId: null,
    })

    restarted.beginAttempt('chat-session', { manual: true })
    restarted.attachInteraction('ask_profile_2')
    expect(restarted.defer('ask_profile_2').status).toBe('pending')
    expect(restarted.skip().status).toBe('skipped')
    expect(
      new ProfileOnboardingCoordinator({
        stateRoot,
        templatesDir,
        userFile,
      }).payload().status,
    ).toBe('skipped')
  })

  it('marks a patched or manually customized profile completed', () => {
    const stateRoot = tmp('emperor-onboarding-state-complete-')
    const templatesDir = seedTemplatesDir(stateRoot, SEED)
    const userFile = ensureUserProfileFile(stateRoot, templatesDir)
    const coordinator = new ProfileOnboardingCoordinator({
      stateRoot,
      templatesDir,
      userFile,
    })
    coordinator.beginAttempt('chat-session', { manual: false })
    writeFileSync(userFile, '# 用户档案\n\n- **称呼**：皇上\n', 'utf8')

    expect(coordinator.reconcileProfile().status).toBe('completed')
    expect(coordinator.payload()).toMatchObject({
      status: 'completed',
      sessionId: null,
      interactionId: null,
      canStart: false,
      canSkip: false,
    })
    expect(coordinator.defer('ask_unrelated').status).toBe('completed')
  })

  it('updates an untouched profile when the seed revision changes without losing skip intent', () => {
    const stateRoot = tmp('emperor-onboarding-state-seed-revision-')
    const templatesDir = seedTemplatesDir(stateRoot, SEED)
    const userFile = ensureUserProfileFile(stateRoot, templatesDir)
    const first = new ProfileOnboardingCoordinator({
      stateRoot,
      templatesDir,
      userFile,
    })
    first.skip()
    const nextSeed = '# 用户档案\n\n- **称呼**：未设置\n- **语言**：中文\n'
    writeFileSync(join(templatesDir, 'init', 'USER.md'), nextSeed, 'utf8')

    const upgraded = new ProfileOnboardingCoordinator({
      stateRoot,
      templatesDir,
      userFile,
    })

    expect(upgraded.payload().status).toBe('skipped')
    expect(readFileSync(userFile, 'utf8')).toBe(nextSeed)
    expect(
      JSON.parse(readFileSync(join(stateRoot, 'onboarding.json'), 'utf8'))
        .profile.seedHash,
    ).toBe(upgraded.seedHash)
  })

  it('preserves a corrupt state file and derives status from the current profile', () => {
    const stateRoot = tmp('emperor-onboarding-state-corrupt-')
    const templatesDir = seedTemplatesDir(stateRoot, SEED)
    const userFile = ensureUserProfileFile(stateRoot, templatesDir)
    writeFileSync(join(stateRoot, 'onboarding.json'), '{not-json', 'utf8')

    const coordinator = new ProfileOnboardingCoordinator({
      stateRoot,
      templatesDir,
      userFile,
    })

    expect(coordinator.payload().status).toBe('pending')
    expect(
      readdirSync(stateRoot).some((name) =>
        name.startsWith('onboarding.json.corrupt-'),
      ),
    ).toBe(true)
  })
})

describe('claimProfileOnboardingTrigger', () => {
  it('fires exactly once on a genuine first run with a configured model', () => {
    const stateRoot = tmp('emperor-onboarding-claim-fresh-')
    const templatesDir = seedTemplatesDir(stateRoot, SEED)
    ensureUserProfileFile(stateRoot, templatesDir)

    const first = claimProfileOnboardingTrigger({
      stateRoot,
      templatesDir,
      hasConfiguredModel: true,
    })
    const second = claimProfileOnboardingTrigger({
      stateRoot,
      templatesDir,
      hasConfiguredModel: true,
    })

    expect(first).toBe(true)
    expect(second).toBe(false)
    expect(existsSync(join(stateRoot, 'onboarding.json'))).toBe(true)
  })

  it('latches immediately without firing when the profile is already customized (upgrade path)', () => {
    const stateRoot = tmp('emperor-onboarding-claim-customized-')
    const templatesDir = seedTemplatesDir(stateRoot, SEED)
    mkdirSync(join(stateRoot, 'memory', 'profile'), { recursive: true })
    writeFileSync(
      join(stateRoot, 'memory', 'profile', 'USER.local.md'),
      '# 用户档案\n\n- **称呼**：皇上\n',
      'utf8',
    )

    const result = claimProfileOnboardingTrigger({
      stateRoot,
      templatesDir,
      hasConfiguredModel: true,
    })

    expect(result).toBe(false)
    expect(existsSync(join(stateRoot, 'onboarding.json'))).toBe(true)
  })

  it('does not latch when the model is not configured yet, so a later boot can retry', () => {
    const stateRoot = tmp('emperor-onboarding-claim-no-model-')
    const templatesDir = seedTemplatesDir(stateRoot, SEED)
    ensureUserProfileFile(stateRoot, templatesDir)

    const result = claimProfileOnboardingTrigger({
      stateRoot,
      templatesDir,
      hasConfiguredModel: false,
    })

    expect(result).toBe(false)
    expect(existsSync(join(stateRoot, 'onboarding.json'))).toBe(false)

    const retry = claimProfileOnboardingTrigger({
      stateRoot,
      templatesDir,
      hasConfiguredModel: true,
    })
    expect(retry).toBe(true)
  })
})

describe('AgentLoop.create() first-run onboarding integration (opt-in, 2026-07-06)', () => {
  it('lets the Agent derive its first Ask from the profile template without a visible user message', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-onboarding-e2e-fresh-'))
    const provider = new AskingFakeProvider()
    const events: Array<Record<string, unknown>> = []

    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
      enableFirstRunOnboarding: true,
      eventSink: async (event) => {
        events.push(event)
      },
    })

    expect(provider.calls).toHaveLength(1)
    expect(JSON.stringify(provider.calls[0]?.messages)).toContain(
      '[PROFILE_ONBOARDING]',
    )
    expect(JSON.stringify(provider.calls[0]?.messages)).toContain('## 基本信息')
    expect(
      events.find(
        (event) =>
          event.event === 'user_message' &&
          event.source === 'onboarding' &&
          event.ui_hidden !== true,
      ),
    ).toBeUndefined()
    expect(
      events.find(
        (event) =>
          event.event === 'user_message' && event.source === 'onboarding',
      ),
    ).toMatchObject({ ui_hidden: true, content: '' })
    expect(
      events.find((event) => event.event === 'message_delta'),
    ).toMatchObject({
      source: 'onboarding',
      delta: expect.stringContaining('根据个人偏好模板'),
    })
    const askEvent = events.find((event) => event.event === 'ask_request')
    expect(askEvent).toMatchObject({
      source: 'onboarding',
      interaction: {
        questions: expect.arrayContaining([
          expect.objectContaining({ id: 'dynamic_priority' }),
        ]),
        meta: { profileOnboardingVersion: 2 },
      },
    })
    expect(
      (askEvent?.interaction as { questions?: unknown[] }).questions,
    ).toHaveLength(1)
    expect(events.find((event) => event.event === 'turn_paused')).toMatchObject(
      {
        source: 'onboarding',
      },
    )
    const rows = readFileSync(loop.activeMemoryStore.historyFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(loop.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: expect.stringContaining('根据个人偏好模板'),
        }),
      ]),
    )
    expect(rows.find((row) => row.role === 'user')).toMatchObject({
      source: 'onboarding',
      ui_hidden: true,
    })
    expect(existsSync(join(root, '.emperor', 'onboarding.json'))).toBe(true)

    await loop.close()
  })

  it('does not fire when the model is not configured yet and persists pending for a later retry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-onboarding-e2e-no-model-'))
    const events: Array<Record<string, unknown>> = []

    // 不传 modelRouter：走真实 loadModelConfig 路径，全新安装下 models 为空数组
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      enableFirstRunOnboarding: true,
      eventSink: async (event) => {
        events.push(event)
      },
    })

    expect(
      events.find(
        (event) =>
          event.event === 'user_message' && event.source === 'onboarding',
      ),
    ).toBeUndefined()
    expect(
      JSON.parse(
        readFileSync(join(root, '.emperor', 'onboarding.json'), 'utf8'),
      ),
    ).toMatchObject({ version: 2, profile: { status: 'pending' } })

    await loop.close()
  })

  it('does not fire for an already-customized profile (upgrade path) but does latch immediately', async () => {
    const root = mkdtempSync(
      join(tmpdir(), 'emperor-onboarding-e2e-existing-user-'),
    )
    mkdirSync(join(root, '.emperor', 'memory', 'profile'), { recursive: true })
    writeFileSync(
      join(root, '.emperor', 'memory', 'profile', 'USER.local.md'),
      '# 用户档案\n\n- **称呼**：皇上\n',
      'utf8',
    )
    const provider = new AskingFakeProvider()
    const events: Array<Record<string, unknown>> = []

    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
      enableFirstRunOnboarding: true,
      eventSink: async (event) => {
        events.push(event)
      },
    })

    expect(provider.calls.length).toBe(0)
    expect(
      events.find(
        (event) =>
          event.event === 'user_message' && event.source === 'onboarding',
      ),
    ).toBeUndefined()
    expect(existsSync(join(root, '.emperor', 'onboarding.json'))).toBe(true)

    await loop.close()
  })

  it('does nothing when the caller does not opt in, even on a genuine first run with a configured model', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-onboarding-e2e-optout-'))
    const provider = new AskingFakeProvider()
    const events: Array<Record<string, unknown>> = []

    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
      eventSink: async (event) => {
        events.push(event)
      },
    })

    expect(provider.calls.length).toBe(0)
    expect(
      events.find(
        (event) =>
          event.event === 'user_message' && event.source === 'onboarding',
      ),
    ).toBeUndefined()
    expect(
      JSON.parse(
        readFileSync(join(root, '.emperor', 'onboarding.json'), 'utf8'),
      ),
    ).toMatchObject({ version: 2, profile: { status: 'pending' } })

    await loop.close()
  })

  it('supersedes a matching legacy model-generated onboarding Ask on restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-onboarding-legacy-ask-'))
    const stateRoot = join(root, '.emperor')
    const first = await AgentLoop.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new AskingFakeProvider()),
      enableFirstRunOnboarding: true,
    })
    const oldPending = first.controlManager.payload().pending as {
      id: string
    }
    await first.close()

    const controlPath = join(stateRoot, 'control', 'state.json')
    const control = JSON.parse(readFileSync(controlPath, 'utf8')) as {
      pending: { meta: Record<string, unknown> }
    }
    control.pending.meta = {}
    writeFileSync(controlPath, `${JSON.stringify(control, null, 2)}\n`, 'utf8')
    const events: Array<Record<string, unknown>> = []

    const restarted = await AgentLoop.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new AskingFakeProvider()),
      enableFirstRunOnboarding: true,
      eventSink: async (event) => {
        events.push(event)
      },
    })

    const pending = restarted.controlManager.payload().pending as {
      id: string
      questions: unknown[]
      meta: Record<string, unknown>
    }
    expect(pending.id).not.toBe(oldPending.id)
    expect(pending.questions).toHaveLength(1)
    expect(pending.meta).toMatchObject({ profileOnboardingVersion: 2 })
    expect(
      events.find(
        (event) =>
          event.event === 'interaction_cancelled' &&
          (event.interaction as { id?: string } | undefined)?.id ===
            oldPending.id,
      ),
    ).toBeTruthy()

    await restarted.close()
  })
})
