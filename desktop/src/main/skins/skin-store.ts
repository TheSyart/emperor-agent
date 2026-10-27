/**
 * Where skins live (BRD-05): the official ones in the app's resources
 * (`resources/skins/<id>/`, read-only), imported ones in the Emperor Home
 * (`<state root>/skins/<id>/`). Every read checks the folder again
 * (skin-package.ts), so a skin edited or deleted by hand is caught.
 *
 * Importing copies only skin.json and the pictures its slots name, through
 * a staging folder that is checked once more before it takes the id.
 * `asset()` hands out only a slot's picture of a skin that still passes,
 * re-reading the bytes and their header; nothing else is ever served.
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  OFFICIAL_SKIN_IDS,
  SKIN_ID_PATTERN,
  type SkinListEntry,
  type SkinView,
} from '../../shared/skin-contract'
import { imageMime, sniffImage } from './skin-image'
import {
  inspectSkinFolder,
  SKIN_LIMITS,
  SKIN_MANIFEST,
  skinView,
  type LoadedSkin,
  type SkinImageFile,
} from './skin-package'
import type { ThemeTokens } from './theme-tokens'

export interface SkinStoreOptions {
  officialRoot: string
  userRoot: string
  tokens: ThemeTokens
}

export type SkinInspectResult =
  | { ok: true; view: SkinView; replaces: boolean }
  | { ok: false; problems: string[] }

export type SkinInstallResult =
  { ok: true; view: SkinView } | { ok: false; problems: string[] }

function version(image: SkinImageFile): string {
  return createHash('sha256')
    .update(`${image.bytes}:${image.mtimeMs}`)
    .digest('hex')
    .slice(0, 12)
}

function folders(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && SKIN_ID_PATTERN.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

export class SkinStore {
  constructor(private readonly options: SkinStoreOptions) {}

  private officialIds(): string[] {
    const present = folders(this.options.officialRoot)
    const known = OFFICIAL_SKIN_IDS.filter((id) => present.includes(id))
    return [...known, ...present.filter((id) => !known.includes(id as never))]
  }

  private isOfficial(id: string): boolean {
    return this.officialIds().includes(id)
  }

  private load(
    id: string,
  ): { skin: LoadedSkin; official: boolean } | { problems: string[] } | null {
    if (!SKIN_ID_PATTERN.test(id)) return null
    const official = this.isOfficial(id)
    const folder = join(
      official ? this.options.officialRoot : this.options.userRoot,
      id,
    )
    if (!existsSync(folder)) return null
    if (!official && lstatSync(folder).isSymbolicLink())
      return { problems: ['皮肤文件夹不能是链接'] }
    const result = inspectSkinFolder(folder, this.options.tokens)
    if (!result.ok) return { problems: result.problems }
    if (result.skin.id !== id)
      return {
        problems: [
          `文件夹名「${id}」和 skin.json 里的 id「${result.skin.id}」不一致`,
        ],
      }
    return { skin: result.skin, official }
  }

  private view(skin: LoadedSkin, official: boolean): SkinView {
    return skinView(skin, this.options.tokens, {
      official,
      assetUrl: (file, image) =>
        `app://skin/${skin.id}/${file}?v=${version(image)}`,
    })
  }

  /** Official skins in their order, then imported ones (broken ones say why). */
  list(): SkinListEntry[] {
    const official = this.officialIds()
    const imported = folders(this.options.userRoot).filter(
      (id) => !official.includes(id),
    )
    const out: SkinListEntry[] = []
    for (const id of [...official, ...imported]) {
      const loaded = this.load(id)
      if (!loaded) continue
      if ('skin' in loaded)
        out.push({
          ok: true,
          id,
          view: this.view(loaded.skin, loaded.official),
        })
      else
        out.push({
          ok: false,
          id,
          name: id,
          official: false,
          problems: loaded.problems,
        })
    }
    return out
  }

  /** A skin that is there and passes, or null. */
  get(id: string): SkinView | null {
    const loaded = this.load(id)
    return loaded && 'skin' in loaded
      ? this.view(loaded.skin, loaded.official)
      : null
  }

  /** Checks a folder the user picked, before importing it. */
  inspect(folder: string): SkinInspectResult {
    const result = inspectSkinFolder(folder, this.options.tokens)
    if (!result.ok) return result
    if (this.isOfficial(result.skin.id))
      return {
        ok: false,
        problems: [
          `id「${result.skin.id}」是官方皮肤的，导入的皮肤要换一个 id`,
        ],
      }
    return {
      ok: true,
      view: this.view(result.skin, false),
      replaces: existsSync(join(this.options.userRoot, result.skin.id)),
    }
  }

  /** Copies a checked package into the Home, replacing one with its id. */
  install(folder: string): SkinInstallResult {
    const inspected = this.inspect(folder)
    if (!inspected.ok) return inspected
    const source = inspectSkinFolder(folder, this.options.tokens)
    if (!source.ok) return source
    const skin = source.skin
    const root = this.options.userRoot
    mkdirSync(root, { recursive: true })
    const suffix = randomBytes(6).toString('hex')
    const staging = join(root, `.staging-${suffix}`)
    mkdirSync(staging)
    try {
      copyFileSync(join(folder, SKIN_MANIFEST), join(staging, SKIN_MANIFEST))
      for (const file of new Set(Object.values(skin.slots)))
        if (file) copyFileSync(join(folder, file), join(staging, file))
      const copied = inspectSkinFolder(staging, this.options.tokens)
      if (!copied.ok || copied.skin.id !== skin.id) {
        rmSync(staging, { recursive: true, force: true })
        return copied.ok
          ? { ok: false, problems: ['复制后的皮肤和原来的不一致'] }
          : copied
      }
      const target = join(root, skin.id)
      const trash = join(root, `.old-${suffix}`)
      if (existsSync(target)) renameSync(target, trash)
      renameSync(staging, target)
      rmSync(trash, { recursive: true, force: true })
    } catch (error) {
      rmSync(staging, { recursive: true, force: true })
      throw error
    }
    const view = this.get(skin.id)
    return view
      ? { ok: true, view }
      : { ok: false, problems: ['导入后读不出这个皮肤'] }
  }

  /** Deletes an imported skin. Official skins cannot be deleted. */
  remove(id: string): boolean {
    if (!SKIN_ID_PATTERN.test(id)) throw new Error('无效的皮肤')
    if (this.isOfficial(id)) throw new Error('官方皮肤不能删除')
    const target = join(this.options.userRoot, id)
    if (!existsSync(target)) return false
    rmSync(target, { recursive: true, force: true })
    return true
  }

  /** A slot picture's bytes, checked again; null for anything else. */
  asset(
    id: string,
    file: string,
  ): { mime: 'image/png' | 'image/webp'; bytes: Buffer } | null {
    const loaded = this.load(id)
    if (!loaded || !('skin' in loaded)) return null
    const { skin } = loaded
    if (!Object.values(skin.slots).includes(file)) return null
    const image = skin.images[file]
    if (!image) return null
    let bytes: Buffer
    try {
      bytes = readFileSync(join(skin.folder, file))
    } catch {
      return null
    }
    if (bytes.length > SKIN_LIMITS.imageBytes) return null
    const info = sniffImage(bytes)
    if (!info || info.type !== image.type) return null
    return { mime: imageMime(info.type), bytes }
  }
}
