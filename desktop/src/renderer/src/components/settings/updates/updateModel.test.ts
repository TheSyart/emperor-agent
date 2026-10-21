import { describe, expect, it } from 'vitest'
import type { UpdateStatus } from '@emperor/core/runtime-contract'
import {
  UPDATE_INSTALL_STEPS,
  attestationText,
  downloadFraction,
  downloadProgressText,
  megabytes,
  updateStatusText,
} from './updateModel'

function updateStatus(patch: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    supported: true,
    automatic: true,
    disabledReason: null,
    enabled: true,
    currentVersion: '0.2.0',
    channel: 'stable',
    checking: false,
    lastCheckedAt: null,
    lastError: null,
    available: null,
    download: { phase: 'idle' },
    electron: {
      current: '42.2.0',
      latest: null,
      behind: null,
      outdated: false,
    },
    feedOverride: null,
    ...patch,
  }
}

const RELEASE = {
  version: '0.2.1',
  tag: 'v0.2.1',
  channel: 'stable' as const,
  name: 'Emperor Agent v0.2.1',
  publishedAt: '2026-10-21T08:00:00Z',
  notesUrl: 'https://github.com/TheSyart/emperor-agent/releases/tag/v0.2.1',
  asset: { name: 'Emperor-Agent-0.2.1-macos-arm64.dmg', size: 231_467_959 },
}

describe('update status line (REL-02)', () => {
  const now = new Date(2026, 9, 21, 15, 0).getTime()

  it('1 · names a newer version; 2 · says it is up to date otherwise', () => {
    expect(updateStatusText(updateStatus({ available: RELEASE }), now)).toBe(
      'Emperor 0.2.1 可用',
    )
    expect(
      updateStatusText(
        updateStatus({ lastCheckedAt: new Date(2026, 9, 21, 14, 3).getTime() }),
        now,
      ),
    ).toBe('已是最新版本 · 上次检查 今天 14:03')
    expect(
      updateStatusText(
        updateStatus({ lastCheckedAt: new Date(2026, 9, 20, 9, 5).getTime() }),
        now,
      ),
    ).toBe('已是最新版本 · 上次检查 10 月 20 日 09:05')
    expect(updateStatusText(updateStatus(), now)).toBe('启动 30 秒后检查')
  })

  it('6 · off, development and failed checks each say so', () => {
    expect(updateStatusText(updateStatus({ enabled: false }), now)).toBe(
      '已关闭：Emperor 不会联网查看新版本',
    )
    expect(
      updateStatusText(
        updateStatus({ automatic: false, disabledReason: 'development' }),
        now,
      ),
    ).toBe('开发版不检查更新')
    expect(
      updateStatusText(
        updateStatus({
          lastError: {
            code: 'update_network_failed',
            message: '连接 GitHub 失败：timeout。',
          },
        }),
        now,
      ),
    ).toBe('上次检查没有成功：连接 GitHub 失败：timeout。 稍后会自动重试。')
    expect(updateStatusText(updateStatus({ checking: true }), now)).toBe(
      '正在检查…',
    )
  })
})

describe('download text (REL-02)', () => {
  it('shows progress in MB and the verification steps', () => {
    const downloading = {
      phase: 'downloading' as const,
      version: '0.2.1',
      fileName: RELEASE.asset.name,
      receivedBytes: 120 * 1024 * 1024,
      totalBytes: 231_467_959,
    }
    expect(downloadProgressText(downloading)).toBe('已下载 120 MB / 221 MB')
    expect(downloadFraction(downloading)).toBeCloseTo(0.5436, 3)
    expect(megabytes(3 * 1024 * 1024)).toBe('3.0 MB')
    expect(
      downloadProgressText({
        phase: 'verifying',
        version: '0.2.1',
        fileName: RELEASE.asset.name,
        step: 'attestation',
      }),
    ).toBe('正在核验 GitHub 来源证明…')
  })

  it('says what was verified, and why only SHA-256 when gh cannot', () => {
    expect(attestationText({ status: 'verified' })).toBe(
      'SHA-256 与 GitHub 来源证明都已核对。',
    )
    expect(
      attestationText({ status: 'unavailable', reason: 'gh_missing' }),
    ).toContain('没有可用的 GitHub CLI（gh）')
    expect(
      attestationText({ status: 'unavailable', reason: 'gh_not_logged_in' }),
    ).toContain('gh auth login')
    expect(
      attestationText({ status: 'skipped', reason: 'test_feed' }),
    ).toContain('测试更新源')
  })

  it('gives the three install steps: drag in, allow the first open, grant again', () => {
    expect(UPDATE_INSTALL_STEPS).toHaveLength(3)
    expect(UPDATE_INSTALL_STEPS[0]).toContain('「应用程序」')
    expect(UPDATE_INSTALL_STEPS[1]).toContain('「系统设置 › 隐私与安全性」')
    for (const permission of ['辅助功能', '屏幕录制', '麦克风', '语音识别'])
      expect(UPDATE_INSTALL_STEPS[2]).toContain(permission)
  })
})
