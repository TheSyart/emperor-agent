/**
 * 导出诊断包 (REL-01): main stages the bundle and lists it; the renderer
 * shows the list for the user to confirm, then asks main to export, reveal
 * or discard it, by id only. Loaded with 设置 › 诊断, not at start-up.
 */
import type {
  DiagnosticsBundleExportResult,
  DiagnosticsBundlePrepareResult,
  DiagnosticsBundleView,
} from '../../../shared/ipc-contract'

export type { DiagnosticsBundleView }

interface BundleBridge {
  prepareDiagnosticsBundle?: () => Promise<DiagnosticsBundlePrepareResult>
  exportDiagnosticsBundle?: (
    id: string,
  ) => Promise<DiagnosticsBundleExportResult>
  revealDiagnosticsBundle?: (
    id: string,
  ) => Promise<{ ok: boolean; error?: string }>
  discardDiagnosticsBundle?: (id: string) => Promise<unknown>
}

const UNAVAILABLE = '导出诊断包需要在 Emperor 桌面窗口中使用'

function bridge(): BundleBridge {
  return (
    (globalThis as unknown as { window?: { emperor?: BundleBridge } }).window
      ?.emperor ?? {}
  )
}

export async function prepareDiagnosticsBundle(): Promise<DiagnosticsBundleView> {
  const prepare = bridge().prepareDiagnosticsBundle
  if (!prepare) throw new Error(UNAVAILABLE)
  const result = await prepare()
  if (!result.ok) throw new Error(result.error)
  return result.bundle
}

/** `{ ok: false, canceled: true }` when the save dialog was cancelled. */
export async function exportDiagnosticsBundle(
  id: string,
): Promise<
  { ok: true; name: string; location: string } | { ok: false; canceled: true }
> {
  const run = bridge().exportDiagnosticsBundle
  if (!run) throw new Error(UNAVAILABLE)
  const result = await run(id)
  if (result.ok || 'canceled' in result) return result
  throw new Error(result.error)
}

export async function revealDiagnosticsBundle(id: string): Promise<void> {
  const reveal = bridge().revealDiagnosticsBundle
  if (!reveal) throw new Error(UNAVAILABLE)
  const result = await reveal(id)
  if (!result.ok) throw new Error(result.error || '没能在访达中显示')
}

/** Drop a bundle that was not exported (failures do not matter). */
export async function discardDiagnosticsBundle(id: string): Promise<void> {
  await bridge()
    .discardDiagnosticsBundle?.(id)
    ?.catch(() => undefined)
}
