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

describe('recovery page: logs and the diagnostics bundle (REL-01)', () => {
  const BUNDLE = {
    id: 'b_0123456789ab',
    name: 'emperor-diagnostics-20261020-163000',
    entries: [{ path: 'logs/main.log', title: '主进程日志', bytes: 2048 }],
    excluded: ['会话与消息内容'],
  }

  function handlerWith(
    extra: Partial<Parameters<typeof createRecoveryActionHandler>[0]>,
  ) {
    return createRecoveryActionHandler({
      senderId: 7,
      emperorHome: '/Users/tester/.emperor',
      legacyHome: null,
      retry: vi.fn(),
      openPath: vi.fn(async () => ''),
      exit: vi.fn(),
      ...extra,
    })
  }

  it('names the log file and offers 打开日志 and 导出诊断包', () => {
    const payload = recoveryPayload(new Error('boom'), {
      emperorHome: '/Users/tester/.emperor',
      legacyHome: null,
      logFile: '/Users/tester/Library/Logs/Emperor Agent/main.log',
    })
    expect(payload.logFile).toBe(
      '/Users/tester/Library/Logs/Emperor Agent/main.log',
    )
    const html = createRecoveryHtml(payload)
    expect(html).toContain('id="open-logs"')
    expect(html).toContain('打开日志')
    expect(html).toContain('id="export-bundle"')
    expect(html).toContain('导出诊断包')
    expect(html).toContain('Library/Logs/Emperor Agent/main.log')
    // The list the user confirms before anything is written.
    expect(html).toContain('id="bundle-entries"')
    expect(html).toContain('不包含')
  })

  it('打开日志 opens main.log through main, never a renderer path', async () => {
    const openLogs = vi.fn(async () => '')
    const handler = handlerWith({ openLogs })
    await expect(handler(7, 'open_logs')).resolves.toEqual({ ok: true })
    expect(openLogs).toHaveBeenCalledOnce()
    openLogs.mockResolvedValueOnce('No application knows how to open it')
    await expect(handler(7, 'open_logs')).resolves.toEqual({
      ok: false,
      error: 'No application knows how to open it',
    })
    await expect(handlerWith({})(7, 'open_logs')).resolves.toEqual({
      ok: false,
      error: '日志不可用',
    })
  })

  it('lists the bundle first, then exports or discards it', async () => {
    const diagnostics = {
      prepare: vi.fn(async () => BUNDLE),
      export: vi.fn(async () => ({
        ok: true as const,
        name: `${BUNDLE.name}.zip`,
        location: '~/Desktop',
      })),
      discard: vi.fn(),
    }
    const handler = handlerWith({ diagnostics })
    await expect(handler(7, 'prepare_diagnostics')).resolves.toEqual({
      ok: true,
      bundle: BUNDLE,
    })
    await expect(
      handler(7, 'export_diagnostics', { id: BUNDLE.id }),
    ).resolves.toEqual({
      ok: true,
      name: `${BUNDLE.name}.zip`,
      location: '~/Desktop',
    })
    expect(diagnostics.export).toHaveBeenCalledWith(BUNDLE.id)
    await expect(
      handler(7, 'discard_diagnostics', { id: BUNDLE.id }),
    ).resolves.toEqual({ ok: true })
    expect(diagnostics.discard).toHaveBeenCalledWith(BUNDLE.id)
    await expect(
      handler(7, 'export_diagnostics', { id: '../etc' }),
    ).resolves.toEqual({ ok: false, error: '无效的诊断包' })
    await expect(handler(8, 'prepare_diagnostics')).rejects.toThrow(
      /unauthorized/i,
    )
  })
})
