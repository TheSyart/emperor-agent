import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureUserProfileFile } from '../../sessions/onboarding'
import { OnboardingService } from './onboarding-service'

const SEED = '# 用户档案\n\n## 基本信息\n\n- **称呼**：未设置\n'

function fixture() {
  const stateRoot = mkdtempSync(join(tmpdir(), 'emperor-onboarding-service-'))
  const templatesDir = join(stateRoot, 'repo-templates')
  mkdirSync(join(templatesDir, 'init'), { recursive: true })
  writeFileSync(join(templatesDir, 'init', 'USER.md'), SEED, 'utf8')
  const userFile = ensureUserProfileFile(stateRoot, templatesDir)
  const events: Array<Record<string, any>> = []
  let profileWritten = (): void => {}
  const service = new OnboardingService({
    stateRoot,
    templatesDir,
    userFile,
    readUserProfile: () => readFileSync(userFile, 'utf8'),
    modelAvailable: () => true,
    anyBusy: () => false,
    hasPending: () => false,
    pendingInteractionId: () => null,
    onPendingChange: () => () => {},
    onProfileWrite: (listener) => {
      profileWritten = listener
      return () => {}
    },
    sessions: {
      list: () => [{ id: 'chat-1', mode: 'chat', title: 'Default' }] as never,
      create: () => ({ id: 'chat-1', mode: 'chat', title: 'Default' }) as never,
    },
    // The interview turn never ends in these tests.
    submitHidden: () => new Promise(() => {}),
    cancelInteraction: () => {},
    emit: (event) => {
      events.push(event)
    },
  })
  const write = (name: string) => {
    writeFileSync(userFile, SEED.replace('未设置', name), 'utf8')
    profileWritten()
  }
  const latest = () => events.at(-1)?.profile_onboarding
  return { service, events, write, latest }
}

describe('OnboardingService (UI-S17)', () => {
  it('starts only when asked, with no host switch', () => {
    const { service } = fixture()
    expect(service.payload().status).toBe('pending')
    expect(service.start()).toMatchObject({
      started: true,
      state: { status: 'in_progress' },
    })
  })

  it('pushes a new 称呼 written during the interview without ending it', () => {
    const { service, write, latest } = fixture()
    service.start()
    write('小周')
    expect(latest()).toMatchObject({
      status: 'in_progress',
      addressName: '小周',
    })
    // The state as it stands (payload() would reconcile the saved profile).
    expect(service.coordinator.payload().status).toBe('in_progress')
  })

  it('completes the profile on a write outside the interview and pushes the name', () => {
    const { events, write, latest } = fixture()
    write('小周')
    expect(latest()).toMatchObject({ status: 'completed', addressName: '小周' })
    const count = events.length
    write('小周')
    expect(events).toHaveLength(count)
    write('阿周')
    expect(latest()).toMatchObject({ addressName: '阿周' })
  })
})
