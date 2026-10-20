import { describe, expect, it, vi } from 'vitest'
import {
  DIAGNOSTICS_BUNDLE_DISCARD_CHANNEL,
  DIAGNOSTICS_BUNDLE_EXPORT_CHANNEL,
  DIAGNOSTICS_BUNDLE_PREPARE_CHANNEL,
  DIAGNOSTICS_BUNDLE_REVEAL_CHANNEL,
} from '../shared/ipc-contract'
import { registerDiagnosticsBundleIpc } from './diagnostics-bundle-ipc'

const VIEW = {
  id: 'b_0123456789ab',
  name: 'emperor-diagnostics-20261020-163000',
  entries: [{ path: 'README.txt', title: '说明', bytes: 120 }],
  excluded: ['会话与消息内容'],
}

function setup(
  overrides: { chooseTarget?: () => Promise<string | null> } = {},
) {
  const handlers = new Map<
    string,
    (event: unknown, payload?: unknown) => unknown
  >()
  const bundles = {
    prepare: vi.fn(async () => VIEW),
    export: vi.fn(async (_id: string, target: string) => ({
      name: 'emperor-diagnostics-20261020-163000.zip',
      path: target,
      entries: VIEW.entries,
    })),
    discard: vi.fn(),
    exportedPath: vi.fn((id: string) =>
      id === VIEW.id ? '/Users/me/Desktop/emperor-diagnostics.zip' : null,
    ),
  }
  const reveal = vi.fn()
  const chooseTarget = vi.fn(
    overrides.chooseTarget ??
      (async () => '/Users/me/Desktop/emperor-diagnostics.zip'),
  )
  registerDiagnosticsBundleIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    authorize: (event) => {
      if (event !== 'main') throw new Error('IPC caller is not trusted')
    },
    bundles,
    chooseTarget,
    reveal,
    homeDir: '/Users/me',
  })
  const invoke = async (
    channel: string,
    payload?: unknown,
    event: unknown = 'main',
  ) => await handlers.get(channel)!(event, payload)
  return { invoke, bundles, reveal, chooseTarget, handlers }
}

describe('诊断包 IPC (REL-01)', () => {
  it('prepares, then exports where the user chose', async () => {
    const { invoke, bundles, chooseTarget } = setup()
    expect(await invoke(DIAGNOSTICS_BUNDLE_PREPARE_CHANNEL)).toEqual({
      ok: true,
      bundle: VIEW,
    })
    expect(
      await invoke(DIAGNOSTICS_BUNDLE_EXPORT_CHANNEL, { id: VIEW.id }),
    ).toEqual({
      ok: true,
      name: 'emperor-diagnostics-20261020-163000.zip',
      location: '~/Desktop',
    })
    expect(chooseTarget).toHaveBeenCalledWith(`${VIEW.name}.zip`)
    expect(bundles.export).toHaveBeenCalledWith(
      VIEW.id,
      '/Users/me/Desktop/emperor-diagnostics.zip',
    )
  })

  it('keeps the bundle when the save dialog is cancelled', async () => {
    const { invoke, bundles } = setup({ chooseTarget: async () => null })
    expect(
      await invoke(DIAGNOSTICS_BUNDLE_EXPORT_CHANNEL, { id: VIEW.id }),
    ).toEqual({ ok: false, canceled: true })
    expect(bundles.export).not.toHaveBeenCalled()
    expect(bundles.discard).not.toHaveBeenCalled()
  })

  it('reveals only a bundle it exported, and discards on request', async () => {
    const { invoke, reveal, bundles } = setup()
    expect(
      await invoke(DIAGNOSTICS_BUNDLE_REVEAL_CHANNEL, { id: VIEW.id }),
    ).toEqual({ ok: true })
    expect(reveal).toHaveBeenCalledWith(
      '/Users/me/Desktop/emperor-diagnostics.zip',
    )
    expect(
      await invoke(DIAGNOSTICS_BUNDLE_REVEAL_CHANNEL, { id: 'b_ffffffffffff' }),
    ).toEqual({ ok: false, error: '还没有导出这个诊断包' })
    expect(
      await invoke(DIAGNOSTICS_BUNDLE_DISCARD_CHANNEL, { id: VIEW.id }),
    ).toEqual({ ok: true })
    expect(bundles.discard).toHaveBeenCalledWith(VIEW.id)
  })

  it('refuses malformed ids and untrusted callers', async () => {
    const { invoke, bundles } = setup()
    for (const payload of [
      undefined,
      'b_0123456789ab',
      { id: '../x' },
      { id: 42 },
    ])
      expect(await invoke(DIAGNOSTICS_BUNDLE_EXPORT_CHANNEL, payload)).toEqual({
        ok: false,
        error: '无效的诊断包',
      })
    expect(bundles.export).not.toHaveBeenCalled()
    await expect(
      invoke(DIAGNOSTICS_BUNDLE_PREPARE_CHANNEL, undefined, 'pet'),
    ).rejects.toThrow(/not trusted/)
  })

  it('says why when preparing or exporting fails', async () => {
    const { invoke, bundles } = setup()
    bundles.prepare.mockRejectedValueOnce(new Error('disk full'))
    expect(await invoke(DIAGNOSTICS_BUNDLE_PREPARE_CHANNEL)).toEqual({
      ok: false,
      error: '没能整理诊断包：disk full',
    })
    bundles.export.mockRejectedValueOnce(new Error('诊断包已过期，请重新导出'))
    expect(
      await invoke(DIAGNOSTICS_BUNDLE_EXPORT_CHANNEL, { id: VIEW.id }),
    ).toEqual({ ok: false, error: '诊断包已过期，请重新导出' })
  })
})
