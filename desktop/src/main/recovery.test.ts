import { describe, expect, it, vi } from 'vitest'
import {
  createRecoveryActionHandler,
  createRecoveryHtml,
  recoveryPayload,
  recoveryWindowWebPreferences,
} from './recovery'

describe('bootstrap recovery surface', () => {
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
