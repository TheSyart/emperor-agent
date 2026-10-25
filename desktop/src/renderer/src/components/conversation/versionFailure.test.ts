import { describe, expect, it } from 'vitest'
import type {
  ExecutorUpgradeView,
  VersionFailureContext,
} from '@emperor/core/runtime-contract'
import { versionFailureButtons, versionFailureLine } from './versionFailure'

// VER-06: a version failure, one line and its buttons, as in the approved
// preview § 8 (「Claude Code 2.1.315 不兼容：… 上次正常的版本：2.1.310。」
// 「退回 2.1.310」「打开设置」).

const context = (
  over: Partial<VersionFailureContext> = {},
): VersionFailureContext => ({
  backend: 'claude-code',
  profileId: 'claude-default',
  current: '2.1.315',
  lastGood: '2.1.310',
  verifiedMax: '2.1.310',
  reason: 'Claude Code 2.1.315 自检不兼容：Claude Code 加载了 MCP server：x',
  actions: ['rollback', 'open_settings'],
  ...over,
})
const run = (over: Partial<ExecutorUpgradeView> = {}): ExecutorUpgradeView => ({
  profileId: 'claude-default',
  backend: 'claude-code',
  kind: 'rollback',
  from: '2.1.315',
  target: '2.1.310',
  command: 'npm install -g @anthropic-ai/claude-code@2.1.310',
  state: 'running',
  startedAt: 1,
  log: [],
  ...over,
})
const labels = (buttons: ReturnType<typeof versionFailureButtons>) =>
  buttons.map((b) => b.label)

describe('VER-06', () => {
  it('the line: why, then the last good version', () => {
    expect(versionFailureLine(context())).toBe(
      'Claude Code 2.1.315 自检不兼容：Claude Code 加载了 MCP server：x。上次正常的版本：2.1.310。',
    )
    expect(
      versionFailureLine(
        context({ lastGood: undefined, actions: ['open_settings'] }),
      ),
    ).toBe('Claude Code 2.1.315 自检不兼容：Claude Code 加载了 MCP server：x。')
  })

  it('3 · a last good version: 退回 x, then 打开设置', () => {
    const buttons = versionFailureButtons(context(), null)
    expect(buttons).toEqual([
      {
        action: 'rollback',
        label: '退回 2.1.310',
        variant: 'secondary',
        disabled: false,
      },
      {
        action: 'open_settings',
        label: '打开设置',
        variant: 'ghost',
        disabled: false,
      },
    ])
  })

  it('4 · none, but a verified one: 装 x（已验证）; 重新检查 when the self-check did not finish', () => {
    expect(
      labels(
        versionFailureButtons(
          context({
            current: '2.1.200',
            lastGood: undefined,
            actions: ['install_verified', 'open_settings', 'recheck'],
          }),
          null,
        ),
      ),
    ).toEqual(['装 2.1.310（已验证）', '打开设置', '重新检查'])
  })

  it('a rollback (or upgrade) already running: 正在退回…, disabled', () => {
    const [rollback] = versionFailureButtons(context(), run())
    expect(rollback).toMatchObject({ label: '正在退回…', disabled: true })
    const [install] = versionFailureButtons(
      context({
        lastGood: undefined,
        actions: ['install_verified', 'open_settings'],
      }),
      run({ kind: undefined, target: '2.1.310' }),
    )
    expect(install).toMatchObject({ label: '正在升级…', disabled: true })
    // One that ended does not hold the buttons.
    expect(
      versionFailureButtons(context(), run({ state: 'failed' }))[0],
    ).toMatchObject({ label: '退回 2.1.310', disabled: false })
  })
})
