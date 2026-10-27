/**
 * BRD-05: 设置 › 常规 › 外观 › 皮肤 over IPC, main window only. Main picks
 * the folder (its own dialog) and keeps it under an id; the renderer never
 * names a path.
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SKIN_GET_CHANNEL,
  SKIN_IMPORT_CHANNEL,
  SKIN_IMPORT_PICK_CHANNEL,
  SKIN_LIST_CHANNEL,
  SKIN_REMOVE_CHANNEL,
} from '../../shared/ipc-contract'
import { manifest, tempDir, writeSkin } from '../test-fixtures/skins'
import { registerSkinIpc } from './skin-ipc'
import { SkinStore } from './skin-store'
import { themeTokens } from './theme-sources'

type Handler = (event: unknown, payload?: unknown) => unknown

let home = ''
let picked = ''
let handlers: Map<string, Handler>
let chooseFolder: ReturnType<typeof vi.fn>
const authorize = vi.fn()

beforeEach(() => {
  home = tempDir('emperor-skin-home-')
  picked = tempDir('emperor-skin-pick-')
  handlers = new Map()
  chooseFolder = vi.fn(async () => null as string | null)
  authorize.mockReset()
  const store = new SkinStore({
    officialRoot: join(__dirname, '../../../resources/skins'),
    userRoot: join(home, 'skins'),
    tokens: themeTokens,
  })
  registerSkinIpc({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    authorize,
    store: () => store,
    chooseFolder: () => chooseFolder(),
  })
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(picked, { recursive: true, force: true })
})

function call(channel: string, payload?: unknown): Promise<any> {
  return Promise.resolve(handlers.get(channel)!({ sender: 'main' }, payload))
}

describe('skin IPC', () => {
  it('authorizes every call', async () => {
    await call(SKIN_LIST_CHANNEL)
    await call(SKIN_GET_CHANNEL, { id: 'zhupi' })
    await call(SKIN_REMOVE_CHANNEL, { id: 'x' })
    expect(authorize).toHaveBeenCalledTimes(3)
    authorize.mockImplementationOnce(() => {
      throw new Error('untrusted')
    })
    await expect(call(SKIN_LIST_CHANNEL)).rejects.toThrow('untrusted')
  })

  it('lists and gets skins, and says when one is missing', async () => {
    const list = await call(SKIN_LIST_CHANNEL)
    expect(list.ok).toBe(true)
    expect(list.skins.map((entry: { id: string }) => entry.id)).toEqual([
      'yushufang',
      'zhupi',
      'richang',
    ])
    expect((await call(SKIN_GET_CHANNEL, { id: 'zhupi' })).skin.name).toBe(
      '朱批',
    )
    expect(await call(SKIN_GET_CHANNEL, { id: 'gone' })).toEqual({
      ok: false,
      missing: true,
    })
    expect(await call(SKIN_GET_CHANNEL, { id: '../x' })).toEqual({
      ok: false,
      error: '无效的请求',
    })
  })

  it('imports a picked folder by its staged id, after asking about a replace', async () => {
    chooseFolder.mockResolvedValueOnce(null)
    expect(await call(SKIN_IMPORT_PICK_CHANNEL)).toEqual({
      ok: false,
      canceled: true,
    })
    chooseFolder.mockResolvedValueOnce(writeSkin(picked, 'paper', manifest()))
    const staged = await call(SKIN_IMPORT_PICK_CHANNEL)
    expect(staged).toMatchObject({
      ok: true,
      staged: { replaces: false, skin: { id: 'paper', name: '宣纸' } },
    })
    expect(staged.staged.stageId).toMatch(/^s_[0-9a-f]{12}$/)
    expect(JSON.stringify(staged)).not.toContain(picked)
    const done = await call(SKIN_IMPORT_CHANNEL, {
      stageId: staged.staged.stageId,
    })
    expect(done).toMatchObject({ ok: true, skin: { id: 'paper' } })
    // A staged id is used once.
    expect(
      await call(SKIN_IMPORT_CHANNEL, { stageId: staged.staged.stageId }),
    ).toMatchObject({ ok: false })
    chooseFolder.mockResolvedValueOnce(writeSkin(picked, 'again', manifest()))
    expect((await call(SKIN_IMPORT_PICK_CHANNEL)).staged.replaces).toBe(true)
  })

  it('reports why a picked folder cannot be a skin', async () => {
    chooseFolder.mockResolvedValueOnce(
      writeSkin(picked, 'paper', manifest({ tokens: { '--fs-s': '20px' } })),
    )
    const result = await call(SKIN_IMPORT_PICK_CHANNEL)
    expect(result.ok).toBe(false)
    expect(result.problems.join('\n')).toContain('「--fs-s」')
  })

  it('removes an imported skin and refuses an official one', async () => {
    chooseFolder.mockResolvedValueOnce(writeSkin(picked, 'paper', manifest()))
    const staged = await call(SKIN_IMPORT_PICK_CHANNEL)
    await call(SKIN_IMPORT_CHANNEL, { stageId: staged.staged.stageId })
    expect(await call(SKIN_REMOVE_CHANNEL, { id: 'paper' })).toEqual({
      ok: true,
    })
    expect((await call(SKIN_REMOVE_CHANNEL, { id: 'zhupi' })).ok).toBe(false)
    expect(await call(SKIN_REMOVE_CHANNEL, { id: 1 })).toEqual({
      ok: false,
      error: '无效的请求',
    })
  })
})
