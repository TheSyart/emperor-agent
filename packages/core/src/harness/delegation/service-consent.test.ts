import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { fixture, spec } from './service-test-fixture'
import { DelegationService } from './service'
import { defaultExecutorConfig } from './config'

/** Waits on work that runs processes, Git or the file system: room for a
 * loaded CI runner instead of the 1 s default (FIX-17). */
const LOADED = { timeout: 10_000 }

/** Upper bound on tokens: ASCII at 4 chars per token, anything else 1.5 per char. */
function tokenCeiling(text: string): number {
  let ascii = 0,
    other = 0
  for (const char of text)
    if (char.charCodeAt(0) < 128) ascii++
    else other++
  return Math.ceil(ascii / 4 + other * 1.5)
}

it('injects nothing about external executors when none is enabled', () => {
  const f = fixture()
  f.config.profiles.forEach((p) => {
    p.enabled = false
  })
  expect(f.service.executorContext()).toBe('')
  // An unreadable configuration enables nothing either.
  const broken = new DelegationService({
    ...f.options,
    config: () => {
      throw new Error('EXECUTOR_CONFIG_INVALID')
    },
  })
  expect(broken.executorContext()).toBe('')
  f.cleanup()
})

it('keeps the enabled-executor guidance short and never says to skip the user', () => {
  const f = fixture()
  const text = f.service.executorContext()
  expect(text).toContain('claude-default')
  expect(text).toContain('codex-default')
  expect(text).toMatch(/asks the user/i)
  expect(text).not.toMatch(/without demanding|not a request for user approval/i)
  expect(text).not.toContain('productIntroduction')
  expect(text).not.toContain('"nativeCapabilities"')
  expect(tokenCeiling(text)).toBeLessThan(600)
  f.config.profiles[0]!.enabled = false
  const one = f.service.executorContext()
  expect(one).not.toContain('claude-default')
  expect(one).toContain('codex-default')
  f.cleanup()
})

it('asks for consent before the first dispatch and creates nothing when refused', async () => {
  const f = fixture()
  const consent = vi.fn(async () => false)
  const service = new DelegationService({ ...f.options, consent })
  await expect(service.start(f.owner, spec)).rejects.toThrow(
    'EXECUTOR_CONSENT_DENIED',
  )
  expect(consent).toHaveBeenCalledWith(
    f.owner,
    expect.objectContaining({ id: 'codex-default' }),
    expect.objectContaining({ description: spec.description }),
    undefined,
  )
  expect(service.list()).toEqual([])
  expect(existsSync(join(f.root, 'conversations'))).toBe(false)
  expect(f.adapter.opened).toHaveLength(0)
  consent.mockImplementation(async () => true)
  const record = await service.start(f.owner, {
    ...spec,
    clientRequestId: 'second',
  })
  await service.wait(record.id, record.currentRunId!)
  expect(f.adapter.submitted).toHaveLength(1)
  await service.shutdown()
  f.cleanup()
})

it('a read-only review keeps running when the parent enters plan mode', async () => {
  const f = fixture()
  const record = await f.service.start(f.owner, spec)
  await f.service.wait(record.id, record.currentRunId!)
  const parent = f.options.parent
  f.options.parent = (owner) => ({ ...parent(owner), planMode: true })
  expect(f.service.parentPermissionsRevoked(f.owner.rootSessionId)).toBe(false)
  await f.service.shutdown()
  f.cleanup()
})

it('follow-up messages reach the executor as written, without a Task: header', async () => {
  const f = fixture()
  const record = await f.service.start(f.owner, spec)
  await f.service.wait(record.id, record.currentRunId!)
  expect(f.adapter.submitted[0]!.text).toBe(
    'Task: fixture task\n\nperform fixture',
  )
  await f.service.send(record.id, {
    messageId: 'dgm-followup',
    text: 'also check the tests',
    delivery: 'queue',
  })
  await vi.waitFor(() => expect(f.adapter.submitted).toHaveLength(2), LOADED)
  expect(f.adapter.submitted[1]!.text).toBe('also check the tests')
  await f.service.shutdown()
  f.cleanup()
})

it('both external executors start disabled', () => {
  expect(defaultExecutorConfig().profiles.map((p) => p.enabled)).toEqual([
    false,
    false,
  ])
})
