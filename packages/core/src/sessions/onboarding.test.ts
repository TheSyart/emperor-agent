import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentLoop } from '../agent/loop'
import { LLMProvider, type ChatArgs, type LLMResponse } from '../providers/base'
import type { ModelRoute, ProviderSnapshot } from '../model/router'
import {
  claimProfileOnboardingTrigger,
  ensureUserProfileFile,
  isUserProfileStillDefault,
  onboardingTriggerContent,
} from './onboarding'

const TEMPLATES_DIR = join(__dirname, '..', '..', '..', '..', 'templates')

class AskingFakeProvider extends LLMProvider {
  calls: ChatArgs[] = []
  constructor() { super({ defaultModel: 'fake-main' }) }
  async chat(args: ChatArgs): Promise<LLMResponse> {
    this.calls.push(args)
    if (this.calls.length === 1) {
      return {
        content: '',
        toolCalls: [{
          id: 'call_ask',
          name: 'ask_user',
          arguments: {
            questions: [{
              id: 'name',
              header: '称呼',
              question: '怎么称呼你？',
              options: [{ id: 'a', label: '直接告诉你' }, { id: 'b', label: '暂不透露' }],
            }],
          },
        }],
        finishReason: 'tool_calls',
        usage: { input: 1, output: 1 },
        reasoningContent: null,
        thinkingBlocks: null,
      }
    }
    return { content: '好的。', toolCalls: [], finishReason: 'stop', usage: { input: 1, output: 1 }, reasoningContent: null, thinkingBlocks: null }
  }
}

function fakeRouter(provider: LLMProvider) {
  const snap: ProviderSnapshot = {
    provider, providerName: 'fake', providerLabel: 'Fake', model: 'fake-main', apiBase: null,
    generation: { maxTokens: 2000, temperature: 0.1, reasoningEffort: null }, contextWindowTokens: 100_000,
    config: {}, supportsVision: false, entryName: 'fake', entryLabel: 'Fake', modelRole: 'main', routeReason: 'fake',
  }
  return {
    route: (useCase: string): ModelRoute => ({ snapshot: snap, fallback: null, useCase, reason: `${useCase}:fake`, estimatedTokens: null }),
    payload: () => ({ mainModel: 'fake-main', secondaryModel: 'fake-secondary' }),
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
    mkdirSync(join(stateRoot, 'templates'), { recursive: true })
    writeFileSync(join(stateRoot, 'templates', 'USER.local.md'), '# customized\n', 'utf8')

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
    expect(isUserProfileStillDefault('# 用户档案\n\n- **称呼**：李公公\n', SEED)).toBe(false)
  })
})

describe('claimProfileOnboardingTrigger', () => {
  it('fires exactly once on a genuine first run with a configured model', () => {
    const stateRoot = tmp('emperor-onboarding-claim-fresh-')
    const templatesDir = seedTemplatesDir(stateRoot, SEED)
    ensureUserProfileFile(stateRoot, templatesDir)

    const first = claimProfileOnboardingTrigger({ stateRoot, templatesDir, hasConfiguredModel: true })
    const second = claimProfileOnboardingTrigger({ stateRoot, templatesDir, hasConfiguredModel: true })

    expect(first).toBe(true)
    expect(second).toBe(false)
    expect(existsSync(join(stateRoot, 'onboarding.json'))).toBe(true)
  })

  it('latches immediately without firing when the profile is already customized (upgrade path)', () => {
    const stateRoot = tmp('emperor-onboarding-claim-customized-')
    const templatesDir = seedTemplatesDir(stateRoot, SEED)
    mkdirSync(join(stateRoot, 'templates'), { recursive: true })
    writeFileSync(join(stateRoot, 'templates', 'USER.local.md'), '# 用户档案\n\n- **称呼**：皇上\n', 'utf8')

    const result = claimProfileOnboardingTrigger({ stateRoot, templatesDir, hasConfiguredModel: true })

    expect(result).toBe(false)
    expect(existsSync(join(stateRoot, 'onboarding.json'))).toBe(true)
  })

  it('does not latch when the model is not configured yet, so a later boot can retry', () => {
    const stateRoot = tmp('emperor-onboarding-claim-no-model-')
    const templatesDir = seedTemplatesDir(stateRoot, SEED)
    ensureUserProfileFile(stateRoot, templatesDir)

    const result = claimProfileOnboardingTrigger({ stateRoot, templatesDir, hasConfiguredModel: false })

    expect(result).toBe(false)
    expect(existsSync(join(stateRoot, 'onboarding.json'))).toBe(false)

    const retry = claimProfileOnboardingTrigger({ stateRoot, templatesDir, hasConfiguredModel: true })
    expect(retry).toBe(true)
  })
})

describe('onboardingTriggerContent', () => {
  it('carries the ONBOARDING_TRIGGER marker and instructs ask_user + save_user_profile', () => {
    const content = onboardingTriggerContent()

    expect(content).toContain('[ONBOARDING_TRIGGER]')
    expect(content).toContain('ask_user')
    expect(content).toContain('save_user_profile')
  })
})

describe('AgentLoop.create() first-run onboarding integration (opt-in, 2026-07-06)', () => {
  it('fires the onboarding turn on a genuine first run and the model can reach ask_user/save_user_profile', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-onboarding-e2e-fresh-'))
    const provider = new AskingFakeProvider()
    const events: Array<Record<string, unknown>> = []

    const loop = await AgentLoop.create({
      root,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
      enableFirstRunOnboarding: true,
      eventSink: async (event) => { events.push(event) },
    })

    expect(provider.calls.length).toBeGreaterThan(0)
    const userMessageEvent = events.find((event) => event.event === 'user_message')
    expect(userMessageEvent).toMatchObject({ source: 'onboarding', content: expect.stringContaining('初次见面') })
    const askEvent = events.find((event) => event.event === 'ask_request')
    expect(askEvent).toBeTruthy()
    expect(loop.registry.get('save_user_profile')).toBeTruthy()
    expect(existsSync(join(root, '.emperor', 'onboarding.json'))).toBe(true)

    await loop.close()
  })

  it('does not fire when the model is not configured yet, and does not latch (retries next boot)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-onboarding-e2e-no-model-'))
    const events: Array<Record<string, unknown>> = []

    // 不传 modelRouter：走真实 loadModelConfig 路径，全新安装下 models 为空数组
    const loop = await AgentLoop.create({
      root,
      templatesDir: TEMPLATES_DIR,
      enableFirstRunOnboarding: true,
      eventSink: async (event) => { events.push(event) },
    })

    expect(events.find((event) => event.event === 'user_message' && event.source === 'onboarding')).toBeUndefined()
    expect(existsSync(join(root, '.emperor', 'onboarding.json'))).toBe(false)

    await loop.close()
  })

  it('does not fire for an already-customized profile (upgrade path) but does latch immediately', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-onboarding-e2e-existing-user-'))
    mkdirSync(join(root, '.emperor', 'templates'), { recursive: true })
    writeFileSync(join(root, '.emperor', 'templates', 'USER.local.md'), '# 用户档案\n\n- **称呼**：皇上\n', 'utf8')
    const provider = new AskingFakeProvider()
    const events: Array<Record<string, unknown>> = []

    const loop = await AgentLoop.create({
      root,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
      enableFirstRunOnboarding: true,
      eventSink: async (event) => { events.push(event) },
    })

    expect(provider.calls.length).toBe(0)
    expect(events.find((event) => event.event === 'user_message' && event.source === 'onboarding')).toBeUndefined()
    expect(existsSync(join(root, '.emperor', 'onboarding.json'))).toBe(true)

    await loop.close()
  })

  it('does nothing when the caller does not opt in, even on a genuine first run with a configured model', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-onboarding-e2e-optout-'))
    const provider = new AskingFakeProvider()
    const events: Array<Record<string, unknown>> = []

    const loop = await AgentLoop.create({
      root,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
      eventSink: async (event) => { events.push(event) },
    })

    expect(provider.calls.length).toBe(0)
    expect(events.find((event) => event.event === 'user_message' && event.source === 'onboarding')).toBeUndefined()
    expect(existsSync(join(root, '.emperor', 'onboarding.json'))).toBe(false)

    await loop.close()
  })
})
