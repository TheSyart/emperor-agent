/**
 * 导出诊断包 over IPC (REL-01): the trusted main window prepares a bundle,
 * shows its contents, then asks main to export, reveal or discard it by id.
 * Main alone picks the paths (the save dialog, the staging folder). The
 * recovery page reuses {@link exportDiagnosticsBundle}.
 */
import * as path from 'node:path'
import {
  DIAGNOSTICS_BUNDLE_DISCARD_CHANNEL,
  DIAGNOSTICS_BUNDLE_EXPORT_CHANNEL,
  DIAGNOSTICS_BUNDLE_PREPARE_CHANNEL,
  DIAGNOSTICS_BUNDLE_REVEAL_CHANNEL,
  type DiagnosticsBundleExportResult,
  type DiagnosticsBundlePrepareResult,
} from '../shared/ipc-contract'
import { BUNDLE_ID, type DiagnosticsBundles } from './diagnostics-bundle'

type BundleStore = Pick<
  DiagnosticsBundles,
  'prepare' | 'export' | 'discard' | 'exportedPath'
>

interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: unknown, payload?: unknown) => unknown,
  ): void
}

const INVALID = { ok: false as const, error: '无效的诊断包' }

/** `{ id }` with a well-formed bundle id, else null. */
export function bundleIdOf(payload: unknown): string | null {
  const id =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as { id?: unknown }).id
      : undefined
  return typeof id === 'string' && BUNDLE_ID.test(id) ? id : null
}

export async function prepareDiagnosticsBundle(
  bundles: BundleStore,
): Promise<DiagnosticsBundlePrepareResult> {
  try {
    return { ok: true, bundle: await bundles.prepare() }
  } catch (error) {
    return { ok: false, error: `没能整理诊断包：${messageOf(error)}` }
  }
}

/** Ask where to save bundle `id`, then write the zip there. */
export async function exportDiagnosticsBundle(input: {
  bundles: BundleStore
  id: string
  chooseTarget(defaultName: string): Promise<string | null>
  homeDir: string
  name?: string
}): Promise<DiagnosticsBundleExportResult> {
  try {
    const target = await input.chooseTarget(
      `${input.name ?? 'emperor-diagnostics'}.zip`,
    )
    if (!target) return { ok: false, canceled: true }
    const result = await input.bundles.export(input.id, target)
    const folder = path.dirname(result.path)
    return {
      ok: true,
      name: result.name,
      location:
        input.homeDir &&
        (folder === input.homeDir || folder.startsWith(`${input.homeDir}/`))
          ? `~${folder.slice(input.homeDir.length)}`
          : folder,
    }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

export function registerDiagnosticsBundleIpc(input: {
  ipcMain: IpcMainLike
  authorize(event: unknown): void
  bundles: BundleStore
  /** The save dialog; null when cancelled. */
  chooseTarget(defaultName: string): Promise<string | null>
  /** `shell.showItemInFolder`. */
  reveal(target: string): void
  homeDir: string
}): void {
  const names = new Map<string, string>()
  input.ipcMain.handle(DIAGNOSTICS_BUNDLE_PREPARE_CHANNEL, async (event) => {
    input.authorize(event)
    const result = await prepareDiagnosticsBundle(input.bundles)
    if (result.ok) names.set(result.bundle.id, result.bundle.name)
    return result
  })
  input.ipcMain.handle(
    DIAGNOSTICS_BUNDLE_EXPORT_CHANNEL,
    async (event, payload) => {
      input.authorize(event)
      const id = bundleIdOf(payload)
      if (!id) return INVALID
      return await exportDiagnosticsBundle({
        bundles: input.bundles,
        id,
        chooseTarget: input.chooseTarget,
        homeDir: input.homeDir,
        name: names.get(id),
      })
    },
  )
  input.ipcMain.handle(
    DIAGNOSTICS_BUNDLE_REVEAL_CHANNEL,
    async (event, payload) => {
      input.authorize(event)
      const id = bundleIdOf(payload)
      if (!id) return INVALID
      const target = input.bundles.exportedPath(id)
      if (!target) return { ok: false, error: '还没有导出这个诊断包' }
      input.reveal(target)
      return { ok: true }
    },
  )
  input.ipcMain.handle(
    DIAGNOSTICS_BUNDLE_DISCARD_CHANNEL,
    async (event, payload) => {
      input.authorize(event)
      const id = bundleIdOf(payload)
      if (!id) return INVALID
      input.bundles.discard(id)
      return { ok: true }
    },
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
