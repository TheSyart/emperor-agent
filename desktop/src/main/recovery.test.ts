import { describe, expect, it, vi } from 'vitest'
import {
  createRecoveryActionHandler,
  createRecoveryHtml,
  recoveryPayload,
  recoveryWindowWebPreferences,
} from './recovery'

describe('bootstrap recovery surface', () => {
  it('explains live data ownership without starting Core or offering a lock override', () => {
    const payload = recoveryPayload(
      Object.assign(new Error('private cause'), { code: 'state_root_in_use' }),
      { emperorHome: '/tmp/shared', legacyHome: null },
    )
    expect(payload.errorCode).toBe('state_root_in_use')
    expect(payload.title).toBe('数据目录正在使用')
    expect(payload.message).toContain('退出另一个 App 后重试')
    expect(payload.message).not.toContain('private cause')
  })
  it('names the Emperor holding the directory and offers to switch to it (FIX-07)', async () => {
    const owner = {
      pid: 4242,
      version: '0.2.0',
      startedAt: 1,
      packaged: true,
      appPath: '/Applications/Emperor Agent.app',
    }
    const payload = recoveryPayload(
      Object.assign(new Error('busy'), { code: 'state_root_in_use', owner }),
      { emperorHome: '/tmp/shared', legacyHome: null },
    )
    expect(payload.message).toContain(
      '另一个 Emperor（版本 0.2.0，pid 4242）正在使用这个数据目录',
    )
    expect(payload.canSwitch).toBe(true)
    expect(createRecoveryHtml(payload)).toContain('切换到它')
    const switchToOwner = vi.fn(async () => '')
    const exit = vi.fn()
    const handler = createRecoveryActionHandler({
      senderId: 1,
      emperorHome: '/tmp/shared',
      legacyHome: null,
      retry: vi.fn(),
      openPath: vi.fn(async () => ''),
      exit,
      switchToOwner,
    })
    await expect(handler(1, 'switch_to_owner')).resolves.toEqual({ ok: true })
    expect(switchToOwner).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledOnce()
  })

  it('offers no switch when the holder is a development build', () => {
    const payload = recoveryPayload(
      Object.assign(new Error('busy'), {
        code: 'state_root_in_use',
        owner: {
          pid: 7,
          version: '0.2.0-dev',
          startedAt: 1,
          packaged: false,
          appPath: null,
        },
      }),
      { emperorHome: '/tmp/shared', legacyHome: null },
    )
    expect(payload.message).toContain('版本 0.2.0-dev，pid 7')
    expect(payload.canSwitch).toBe(false)
  })

  it('maps startup failures to stable, bounded payloads without exposing stack traces', () => {
    const error = Object.assign(new Error('layout <broken>'), {
      code: 'installation_layout_newer',
      stack: 'SECRET_STACK',
    })
    const payload = recoveryPayload(error, {
      emperorHome: '/Users/tester/.emperor',
      legacyHome: '/Users/tester/.emperor-agent',
    })

    expect(payload).toEqual({
      schemaVersion: 1,
      errorCode: 'installation_layout_newer',
      title: 'Emperor Home 版本过新',
      message: '当前版本无法安全写入这个 Emperor Home。请升级应用或退出。',
      emperorHome: '/Users/tester/.emperor',
      legacyHome: '/Users/tester/.emperor-agent',
      canRetry: true,
      canSwitch: false,
    })
    const html = createRecoveryHtml(payload)
    expect(html).toContain('installation_layout_newer')
    expect(html).toContain('/Users/tester/.emperor')
    expect(html).not.toContain('SECRET_STACK')
    expect(html).not.toContain('<broken>')
    expect(html).toContain('prefers-reduced-motion')
    expect(html).toContain('prefers-reduced-transparency')
  })

  it('uses a dedicated sandboxed preload and rejects actions from another renderer', async () => {
    const preferences = recoveryWindowWebPreferences('/app/out/main')
    expect(preferences).toEqual({
      preload: '/app/out/preload/recovery.cjs',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    })
    const retry = vi.fn(async () => undefined)
    const openPath = vi.fn(async () => '')
    const exit = vi.fn()
    const handler = createRecoveryActionHandler({
      senderId: 41,
      emperorHome: '/Users/tester/.emperor',
      legacyHome: '/Users/tester/.emperor-agent',
      retry,
      openPath,
      exit,
    })

    await expect(handler(42, 'retry')).rejects.toThrow(/unauthorized/i)
    await expect(handler(41, 'open_emperor_home')).resolves.toEqual({
      ok: true,
    })
    expect(openPath).toHaveBeenCalledWith('/Users/tester/.emperor')
    await expect(handler(41, 'retry')).resolves.toEqual({ ok: true })
    expect(retry).toHaveBeenCalledTimes(1)
    await expect(handler(41, 'exit')).resolves.toEqual({ ok: true })
    expect(exit).toHaveBeenCalledTimes(1)
    await expect(handler(41, 'unknown')).rejects.toThrow(/invalid/i)
  })
})
