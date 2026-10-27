/**
 * Checking a skin package (BRD-05, D8): one folder with `skin.json` and
 * PNG / WebP pictures, nothing else. Every problem is collected with the
 * file or token it is about, in words the 皮肤 page shows as they are.
 *
 * - No scripts, pages, SVG or stylesheets; no other files, folders or
 *   links (Finder's `.DS_Store` is ignored).
 * - A picture's type comes from its header and must match its extension;
 *   at most 512 KB and 2048 × 2048 each, 4 MB together.
 * - Tokens only from the allowlist (theme-tokens.ts), in the token's form.
 * - `--text-1` / `--text-2` at least 4.5 : 1 on `--surface-canvas` and
 *   `--surface-base`, the skin's text and the base theme's (exempt zones
 *   keep the base text on the skin's backgrounds), for each theme it shows.
 */
import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { extname, join } from 'node:path'
import {
  SKIN_FONTS,
  SKIN_ID_PATTERN,
  SKIN_SCHEMA,
  SKIN_SLOTS,
  skinThemes,
  type SkinBase,
  type SkinFont,
  type SkinSlotName,
  type SkinSwatch,
  type SkinTheme,
  type SkinView,
} from '../../shared/skin-contract'
import {
  sniffImage,
  SKIN_IMAGE_HEAD_BYTES,
  type SkinImageInfo,
} from './skin-image'
import type { ThemeTokens } from './theme-tokens'

export const SKIN_LIMITS = {
  imageBytes: 512 * 1024,
  totalBytes: 4 * 1024 * 1024,
  manifestBytes: 64 * 1024,
  files: 16,
  side: 2048,
  tokens: 64,
} as const

export const SKIN_MANIFEST = 'skin.json'

export interface SkinImageFile extends SkinImageInfo {
  bytes: number
  mtimeMs: number
}

export interface LoadedSkin {
  folder: string
  id: string
  name: string
  author: string
  license: string
  description: string
  base: SkinBase
  tokens: Record<string, string>
  fonts: { heading: SkinFont }
  /** Slot → file name in the folder. */
  slots: Partial<Record<SkinSlotName, string>>
  /** Every picture that passed its checks. */
  images: Record<string, SkinImageFile>
}

export type SkinInspection =
  { ok: true; skin: LoadedSkin } | { ok: false; problems: string[] }

const MANIFEST_KEYS = new Set([
  'schema',
  'id',
  'name',
  'author',
  'license',
  'description',
  'base',
  'tokens',
  'fonts',
  'slots',
])
const ACTIVE = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.html',
  '.htm',
  '.xhtml',
  '.svg',
  '.svgz',
  '.css',
  '.wasm',
])
const IMAGE_EXT: Record<string, SkinImageInfo['type']> = {
  '.png': 'png',
  '.webp': 'webp',
}
const FILE_NAME = /^[A-Za-z0-9][\w.-]{0,63}$/
const TRIPLET = /^(\d{1,3}) (\d{1,3}) (\d{1,3})$/
const COLOUR =
  /^rgb\(\s*(\d{1,3}) (\d{1,3}) (\d{1,3})(?:\s*\/\s*(0|1|0?\.\d{1,3}|1\.0{1,3}))?\s*\)$/
/** A tab, line break or other control character. */
function hasControl(value: string): boolean {
  return [...value].some((char) => {
    const code = char.charCodeAt(0)
    return code < 0x20 || code === 0x7f
  })
}

const THEME_WORD: Record<SkinTheme, string> = { light: '浅色', dark: '深色' }
const MIN_CONTRAST = 4.5

type RGB = [number, number, number]

function readHead(path: string): Uint8Array {
  const fd = openSync(path, 'r')
  try {
    const head = Buffer.alloc(SKIN_IMAGE_HEAD_BYTES)
    const read = readSync(fd, head, 0, head.length, 0)
    return head.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

function kb(bytes: number): string {
  return `${Math.ceil(bytes / 1024)} KB`
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function channels(m: RegExpExecArray | null): RGB | null {
  if (!m) return null
  const rgb = [Number(m[1]), Number(m[2]), Number(m[3])] as RGB
  return rgb.every((c) => c <= 255) ? rgb : null
}

function luminance([r, g, b]: RGB): number {
  const channel = (c: number) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

export function contrastRatio(a: RGB, b: RGB): number {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

function ratioText(ratio: number): string {
  return (Math.floor(ratio * 10) / 10).toFixed(1)
}

function optionalText(
  data: Record<string, unknown>,
  key: string,
  max: number,
  problems: string[],
): string {
  const value = data[key]
  if (value === undefined) return ''
  if (typeof value !== 'string' || value.length > max || hasControl(value)) {
    problems.push(`「${key}」要写不超过 ${max} 个字的文字`)
    return ''
  }
  return value.trim()
}

/** The token value in its normal form, or null when it is not the token's form. */
function tokenValue(kind: 'triplet' | 'colour', raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 64) return null
  const value = raw.trim().replace(/\s+/g, ' ')
  if (kind === 'triplet') {
    const rgb = channels(TRIPLET.exec(value))
    return rgb ? rgb.join(' ') : null
  }
  const m = COLOUR.exec(value)
  const rgb = channels(m)
  if (!rgb) return null
  const alpha = m![4]
  return alpha === undefined
    ? `rgb(${rgb.join(' ')})`
    : `rgb(${rgb.join(' ')} / ${Number(alpha)})`
}

interface Files {
  manifest: string | null
  images: Record<string, SkinImageFile>
  imageNames: Set<string>
}

function inspectFiles(folder: string, problems: string[]): Files {
  const files: Files = { manifest: null, images: {}, imageNames: new Set() }
  let entries
  try {
    if (!statSync(folder).isDirectory()) {
      problems.push('选的不是文件夹')
      return files
    }
    entries = readdirSync(folder, { withFileTypes: true })
  } catch {
    problems.push('读不了这个文件夹')
    return files
  }
  const counted = entries.filter((entry) => entry.name !== '.DS_Store')
  if (counted.length > SKIN_LIMITS.files)
    problems.push(
      `皮肤包里有 ${counted.length} 个文件，最多 ${SKIN_LIMITS.files} 个`,
    )
  let total = 0
  for (const entry of counted) {
    const name = entry.name
    const ext = extname(name).toLowerCase()
    if (entry.isSymbolicLink()) {
      problems.push(`「${name}」是链接：皮肤包里只能放文件本身`)
      continue
    }
    if (entry.isDirectory()) {
      problems.push(`「${name}」是文件夹：皮肤包里不能有子文件夹`)
      continue
    }
    if (!entry.isFile()) {
      problems.push(`「${name}」不是普通文件`)
      continue
    }
    if (name === SKIN_MANIFEST) {
      files.manifest = join(folder, name)
      continue
    }
    if (ACTIVE.has(ext)) {
      problems.push(`皮肤包里不能有「${name}」：不能带脚本、网页、SVG 或样式表`)
      continue
    }
    const expected = IMAGE_EXT[ext]
    if (!expected || !FILE_NAME.test(name)) {
      problems.push(
        `「${name}」不是图片：皮肤包里只能有 skin.json 和 PNG / WebP 图片`,
      )
      continue
    }
    files.imageNames.add(name)
    const path = join(folder, name)
    const stat = statSync(path)
    total += stat.size
    if (stat.size > SKIN_LIMITS.imageBytes) {
      problems.push(`「${name}」有 ${kb(stat.size)}，单张图片不能超过 512 KB`)
      continue
    }
    const info = sniffImage(readHead(path))
    if (!info) {
      problems.push(
        `「${name}」的文件头不是 PNG 或 WebP（只看文件内容，不看扩展名）`,
      )
      continue
    }
    if (info.type !== expected) {
      problems.push(
        `「${name}」的文件头是 ${info.type === 'png' ? 'PNG' : 'WebP'}，和扩展名对不上`,
      )
      continue
    }
    if (info.width > SKIN_LIMITS.side || info.height > SKIN_LIMITS.side) {
      problems.push(
        `「${name}」是 ${info.width} × ${info.height}，图片不能大于 ${SKIN_LIMITS.side} × ${SKIN_LIMITS.side}`,
      )
      continue
    }
    files.images[name] = { ...info, bytes: stat.size, mtimeMs: stat.mtimeMs }
  }
  if (total > SKIN_LIMITS.totalBytes)
    problems.push(`图片合计 ${mb(total)}，不能超过 4 MB`)
  return files
}

function readManifest(
  path: string | null,
  problems: string[],
): Record<string, unknown> | null {
  if (!path) {
    problems.push('缺少 skin.json')
    return null
  }
  if (statSync(path).size > SKIN_LIMITS.manifestBytes) {
    problems.push('skin.json 超过 64 KB')
    return null
  }
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (data && typeof data === 'object' && !Array.isArray(data))
      return data as Record<string, unknown>
  } catch {
    // Reported below.
  }
  problems.push('「skin.json」不是有效的 JSON 对象')
  return null
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function inspectSkinFolder(
  folder: string,
  tokens: ThemeTokens,
): SkinInspection {
  const problems: string[] = []
  const files = inspectFiles(folder, problems)
  const data = readManifest(files.manifest, problems)
  if (!data) return { ok: false, problems }

  for (const key of Object.keys(data))
    if (!MANIFEST_KEYS.has(key))
      problems.push(`「${key}」不是 skin.json 认识的字段`)
  if (data.schema !== SKIN_SCHEMA)
    problems.push(
      `不支持的 schema：${JSON.stringify(data.schema ?? null)}（这个版本只认 ${SKIN_SCHEMA}）`,
    )
  const id = typeof data.id === 'string' ? data.id : ''
  if (!SKIN_ID_PATTERN.test(id))
    problems.push('id 只能用小写字母、数字和连字符，2 到 32 个字符')
  const name = optionalText(data, 'name', 40, problems)
  if (!name) problems.push('「name」要写 1 到 40 个字的名字')
  const author = optionalText(data, 'author', 60, problems)
  const license = optionalText(data, 'license', 60, problems)
  const description = optionalText(data, 'description', 120, problems)
  const base = (data.base ?? 'auto') as SkinBase
  if (base !== 'light' && base !== 'dark' && base !== 'auto')
    problems.push('base 只能是 light、dark 或 auto')

  const skinTokens: Record<string, string> = {}
  const rawTokens = data.tokens === undefined ? {} : record(data.tokens)
  if (!rawTokens) problems.push('「tokens」要写成「令牌: 值」的对象')
  else {
    const entries = Object.entries(rawTokens)
    if (entries.length > SKIN_LIMITS.tokens)
      problems.push(
        `改了 ${entries.length} 个令牌，最多 ${SKIN_LIMITS.tokens} 个`,
      )
    for (const [key, raw] of entries) {
      const kind = tokens.allowlist.get(key)
      if (!kind) {
        problems.push(
          `令牌「${key}」不能改：皮肤只能改颜色（表面、文字、描边、品牌和强调色）`,
        )
        continue
      }
      const value = tokenValue(kind, raw)
      if (value === null) {
        problems.push(
          kind === 'triplet'
            ? `令牌「${key}」的值「${String(raw).slice(0, 40)}」要写成「R G B」：三个 0 到 255 的整数`
            : `令牌「${key}」的值「${String(raw).slice(0, 40)}」要写成「rgb(R G B)」或「rgb(R G B / 透明度)」`,
        )
        continue
      }
      skinTokens[key] = value
    }
  }

  let heading: SkinFont = 'system'
  const fonts = data.fonts === undefined ? {} : record(data.fonts)
  if (!fonts) problems.push('「fonts」要写成对象，例如 { "heading": "songti" }')
  else
    for (const [key, value] of Object.entries(fonts)) {
      if (key !== 'heading')
        problems.push(`「fonts」里只能写 heading，没有「${key}」`)
      else if (!SKIN_FONTS.includes(value as SkinFont))
        problems.push(
          `标题字体「${String(value)}」不在可选范围（${SKIN_FONTS.join('、')}）`,
        )
      else heading = value as SkinFont
    }

  const slots: LoadedSkin['slots'] = {}
  const rawSlots = data.slots === undefined ? {} : record(data.slots)
  if (!rawSlots) problems.push('「slots」要写成「装饰位: 文件名」的对象')
  else
    for (const [slot, file] of Object.entries(rawSlots)) {
      if (!SKIN_SLOTS.includes(slot as SkinSlotName)) {
        problems.push(
          `装饰位「${slot}」还没有开放；能用的有 ${SKIN_SLOTS.join('、')}`,
        )
        continue
      }
      if (
        typeof file !== 'string' ||
        !FILE_NAME.test(file) ||
        !IMAGE_EXT[extname(file).toLowerCase()]
      ) {
        problems.push(
          `装饰位「${slot}」的图片「${String(file)}」要写成同一文件夹里的 PNG / WebP 文件名`,
        )
        continue
      }
      if (!files.imageNames.has(file)) {
        problems.push(`装饰位「${slot}」用的「${file}」不在皮肤包里`)
        continue
      }
      if (files.images[file]) slots[slot as SkinSlotName] = file
    }

  if (base === 'light' || base === 'dark' || base === 'auto')
    problems.push(...contrastProblems(skinTokens, base, tokens))

  if (problems.length) return { ok: false, problems }
  return {
    ok: true,
    skin: {
      folder,
      id,
      name,
      author,
      license,
      description,
      base,
      tokens: skinTokens,
      fonts: { heading },
      slots,
      images: files.images,
    },
  }
}

function effective(
  skinTokens: Record<string, string>,
  theme: SkinTheme,
  key: string,
  tokens: ThemeTokens,
): RGB | null {
  const own = skinTokens[key]
  return own ? channels(TRIPLET.exec(own)) : tokens.triplet(theme, key)
}

function contrastProblems(
  skinTokens: Record<string, string>,
  base: SkinBase,
  tokens: ThemeTokens,
): string[] {
  const problems: string[] = []
  for (const theme of skinThemes(base))
    for (const fg of ['--text-1', '--text-2'])
      for (const bg of ['--surface-canvas', '--surface-base']) {
        const back = effective(skinTokens, theme, bg, tokens)
        const text = effective(skinTokens, theme, fg, tokens)
        const baseText = tokens.triplet(theme, fg)
        if (!back || !text || !baseText) continue
        const ratio = contrastRatio(text, back)
        if (ratio < MIN_CONTRAST)
          problems.push(
            `「${fg}」在「${bg}」上的对比度只有 ${ratioText(ratio)} : 1，至少要 4.5 : 1（${THEME_WORD[theme]}）`,
          )
        if (!skinTokens[bg]) continue
        const kept = contrastRatio(baseText, back)
        if (kept < MIN_CONTRAST)
          problems.push(
            `对话正文等不换装的地方用基础主题的「${fg}」，它在「${bg}」上的对比度只有 ${ratioText(kept)} : 1，至少要 4.5 : 1（${THEME_WORD[theme]}）`,
          )
      }
  return problems
}

export interface SkinViewOptions {
  official: boolean
  assetUrl: (file: string, image: SkinImageFile) => string
}

function swatch(
  skin: LoadedSkin,
  theme: SkinTheme,
  tokens: ThemeTokens,
): SkinSwatch | null {
  const pick = (key: string) =>
    effective(skin.tokens, theme, key, tokens)?.join(' ') ?? null
  const values = {
    canvas: pick('--surface-canvas'),
    base: pick('--surface-base'),
    raised: pick('--surface-raised'),
    text1: pick('--text-1'),
    text2: pick('--text-2'),
    brand: pick('--brand'),
  }
  return Object.values(values).every(Boolean) ? (values as SkinSwatch) : null
}

/** What the renderer gets: tokens, exempt-zone values, slot addresses, preview. */
export function skinView(
  skin: LoadedSkin,
  tokens: ThemeTokens,
  options: SkinViewOptions,
): SkinView {
  const reset: SkinView['reset'] = {}
  const preview: SkinView['preview'] = {}
  for (const theme of skinThemes(skin.base)) {
    const table: Record<string, string> = {}
    for (const key of [
      ...tokens.dependents(theme, Object.keys(skin.tokens)),
    ].sort()) {
      const value = tokens.resolve(theme, key)
      if (value !== null) table[key] = value
    }
    reset[theme] = table
    const colours = swatch(skin, theme, tokens)
    if (colours) preview[theme] = colours
  }
  const slots: SkinView['slots'] = {}
  for (const slot of SKIN_SLOTS) {
    const file = skin.slots[slot]
    const image = file ? skin.images[file] : undefined
    if (file && image) slots[slot] = options.assetUrl(file, image)
  }
  return {
    id: skin.id,
    name: skin.name,
    author: skin.author,
    license: skin.license,
    description: skin.description,
    official: options.official,
    base: skin.base,
    tokens: { ...skin.tokens },
    reset,
    fonts: { ...skin.fonts },
    slots,
    preview,
  }
}
