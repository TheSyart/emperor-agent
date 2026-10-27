/**
 * 设置 › 常规 › 外观 › 皮肤 (BRD-05): what main lists, imports and deletes.
 * Main picks the folder (its dialog) and checks every package; the page
 * names skins by id and a picked folder by its staged id. Loaded with the
 * page, not at start-up.
 */
import type {
  SkinImportPickResult,
  SkinImportResult,
  SkinListResult,
  SkinRemoveResult,
} from '../../../../../shared/ipc-contract'
import type {
  SkinListEntry,
  SkinView,
} from '../../../../../shared/skin-contract'

interface SkinsBridge {
  skinList?: () => Promise<SkinListResult>
  skinImportPick?: () => Promise<SkinImportPickResult>
  skinImport?: (stageId: string) => Promise<SkinImportResult>
  skinRemove?: (id: string) => Promise<SkinRemoveResult>
}

const UNAVAILABLE = '皮肤需要在 Emperor 桌面窗口中使用'

function need<K extends keyof SkinsBridge>(
  key: K,
): NonNullable<SkinsBridge[K]> {
  const method = ((globalThis as { window?: { emperor?: SkinsBridge } }).window
    ?.emperor ?? {})[key]
  if (!method) throw new Error(UNAVAILABLE)
  return method as NonNullable<SkinsBridge[K]>
}

export async function listSkins(): Promise<SkinListEntry[]> {
  const result = await need('skinList')()
  if (!result.ok) throw new Error(result.error)
  return result.skins
}

export type PickedSkin =
  | { kind: 'staged'; stageId: string; skin: SkinView; replaces: boolean }
  | { kind: 'canceled' }
  | { kind: 'refused'; problems: string[] }

export async function pickSkinFolder(): Promise<PickedSkin> {
  const result = await need('skinImportPick')()
  if (result.ok) return { kind: 'staged', ...result.staged }
  if ('canceled' in result) return { kind: 'canceled' }
  if ('problems' in result)
    return { kind: 'refused', problems: result.problems }
  throw new Error(result.error)
}

export async function importSkin(
  stageId: string,
): Promise<{ skin: SkinView } | { problems: string[] }> {
  const result = await need('skinImport')(stageId)
  if (result.ok) return { skin: result.skin }
  if ('problems' in result) return { problems: result.problems }
  throw new Error(result.error)
}

export async function removeSkin(id: string): Promise<void> {
  const result = await need('skinRemove')(id)
  if (!result.ok) throw new Error(result.error)
}
