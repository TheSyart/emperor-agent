/**
 * Skins over IPC (BRD-05), trusted main window only. Main alone picks the
 * folder to import (its dialog) and keeps it under a staged id for the
 * renderer to confirm; a replace is the renderer's question to ask.
 */
import { randomBytes } from 'node:crypto'
import {
  SKIN_GET_CHANNEL,
  SKIN_IMPORT_CHANNEL,
  SKIN_IMPORT_PICK_CHANNEL,
  SKIN_LIST_CHANNEL,
  SKIN_REMOVE_CHANNEL,
} from '../../shared/ipc-contract'
import { SKIN_ID_PATTERN } from '../../shared/skin-contract'
import type { SkinStore } from './skin-store'

interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: unknown, payload?: unknown) => unknown,
  ): void
}

const INVALID = { ok: false as const, error: '无效的请求' }
const STAGE_ID = /^s_[0-9a-f]{12}$/
const STAGE_LIMIT = 8

function field(payload: unknown, key: string): unknown {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)[key]
    : undefined
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function registerSkinIpc(input: {
  ipcMain: IpcMainLike
  authorize(event: unknown): void
  store(): SkinStore
  /** The folder dialog; null when cancelled. */
  chooseFolder(): Promise<string | null>
}): void {
  const staged = new Map<string, string>()
  const handle = (channel: string, run: (payload: unknown) => unknown): void =>
    input.ipcMain.handle(channel, async (event, payload) => {
      input.authorize(event)
      try {
        return await run(payload)
      } catch (error) {
        return { ok: false, error: message(error) }
      }
    })

  handle(SKIN_LIST_CHANNEL, () => ({ ok: true, skins: input.store().list() }))

  handle(SKIN_GET_CHANNEL, (payload) => {
    const id = field(payload, 'id')
    if (typeof id !== 'string' || !SKIN_ID_PATTERN.test(id)) return INVALID
    const skin = input.store().get(id)
    return skin ? { ok: true, skin } : { ok: false, missing: true }
  })

  handle(SKIN_IMPORT_PICK_CHANNEL, async () => {
    const folder = await input.chooseFolder()
    if (!folder) return { ok: false, canceled: true }
    const inspected = input.store().inspect(folder)
    if (!inspected.ok) return { ok: false, problems: inspected.problems }
    const stageId = `s_${randomBytes(6).toString('hex')}`
    staged.set(stageId, folder)
    while (staged.size > STAGE_LIMIT) staged.delete(staged.keys().next().value!)
    return {
      ok: true,
      staged: { stageId, skin: inspected.view, replaces: inspected.replaces },
    }
  })

  handle(SKIN_IMPORT_CHANNEL, (payload) => {
    const stageId = field(payload, 'stageId')
    if (typeof stageId !== 'string' || !STAGE_ID.test(stageId)) return INVALID
    const folder = staged.get(stageId)
    if (!folder)
      return { ok: false, error: '这次导入已经过期，请重新选择文件夹' }
    staged.delete(stageId)
    const result = input.store().install(folder)
    return result.ok
      ? { ok: true, skin: result.view }
      : { ok: false, problems: result.problems }
  })

  handle(SKIN_REMOVE_CHANNEL, (payload) => {
    const id = field(payload, 'id')
    if (typeof id !== 'string' || !SKIN_ID_PATTERN.test(id)) return INVALID
    input.store().remove(id)
    return { ok: true }
  })
}
