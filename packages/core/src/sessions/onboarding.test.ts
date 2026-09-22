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
import {
  ProfileOnboardingCoordinator,
  claimProfileOnboardingTrigger,
  ensureUserProfileFile,
  isUserProfileStillDefault,
  profileOnboardingAgentPrompt,
} from './onboarding'

const TEMPLATES_DIR = join(__dirname, '..', '..', '..', '..', 'templates')

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

describe('profileOnboardingAgentPrompt', () => {
  it('embeds the repo profile template and the current profile as data blocks', () => {
    const template = readFileSync(
      join(TEMPLATES_DIR, 'init', 'USER.md'),
      'utf8',
    )
    const prompt = profileOnboardingAgentPrompt(template, '  # 当前档案\n  ')
    expect(prompt.startsWith('[PROFILE_ONBOARDING]\n')).toBe(true)
    expect(prompt).toContain('ask_user_question')
    expect(prompt).toContain('memory_edit')
    expect(prompt).toContain(
      `<profile_template>\n${template.trim()}\n</profile_template>`,
    )
    expect(prompt).toContain(
      '<current_profile>\n# 当前档案\n</current_profile>',
    )
  })

  it('tolerates empty inputs', () => {
    const prompt = profileOnboardingAgentPrompt('', '')
    expect(prompt).toContain('<profile_template>\n\n</profile_template>')
    expect(prompt).toContain('<current_profile>\n\n</current_profile>')
  })
})

describe('ProfileOnboardingCoordinator first-run flow (repo templates)', () => {
  it('starts one automatic attempt per process, attaches the Ask, and completes after a profile edit', () => {
    const root = tmp('emperor-onboarding-flow-')
    const stateRoot = join(root, '.emperor')
    const coordinator = new ProfileOnboardingCoordinator({
      stateRoot,
      templatesDir: TEMPLATES_DIR,
    })
    expect(existsSync(coordinator.userFile)).toBe(true)
    expect(coordinator.payload()).toMatchObject({
      status: 'pending',
      canStart: true,
    })

    const started = coordinator.beginAttempt('sess_1', { manual: false })
    expect(started.started).toBe(true)
    expect(coordinator.payload()).toMatchObject({
      status: 'in_progress',
      sessionId: 'sess_1',
    })
    expect(coordinator.beginAttempt('sess_2', { manual: false }).started).toBe(
      false,
    )

    const prompt = profileOnboardingAgentPrompt(
      coordinator.seedContent,
      readFileSync(coordinator.userFile, 'utf8'),
    )
    expect(prompt).toContain(coordinator.seedContent.trim())

    expect(coordinator.attachInteraction('ask_1')).toMatchObject({
      interactionId: 'ask_1',
    })
    writeFileSync(
      coordinator.userFile,
      '# 用户档案\n\n- **称呼**：皇上\n',
      'utf8',
    )
    expect(coordinator.reconcileProfile().status).toBe('completed')
    expect(existsSync(join(stateRoot, 'onboarding.json'))).toBe(true)
  })
})
