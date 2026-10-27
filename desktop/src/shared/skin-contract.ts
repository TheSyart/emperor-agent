/**
 * Skins (BRD-05, D8): what main hands the renderer about a skin, and the
 * renderer's own last check of it. A skin changes the look only: colour
 * tokens from an allowlist, the heading font from a short list and a few
 * PNG / WebP decorations. Main validates every package
 * (main/skins/skin-package.ts) and serves its images read-only through
 * `app://skin/<id>/<file>`; docs/design/skins.md is the format for authors.
 */

export const SKIN_SCHEMA = 1
/** 御书房: today's look, both themes, the robe 小单 at the sidebar's foot. */
export const DEFAULT_SKIN_ID = 'yushufang'
/** The official skins in list order (desktop/resources/skins/<id>/). */
export const OFFICIAL_SKIN_IDS = ['yushufang', 'zhupi', 'richang'] as const
export const SKIN_ID_PATTERN = /^[a-z0-9-]{2,32}$/

/**
 * Where a skin may place a picture. `hero`: above the greeting of an empty
 * home; `sidebarFooter`: the sidebar's foot; `approved`: a stamp shown for
 * a moment after the user allows an action (never on the card itself).
 */
export const SKIN_SLOTS = ['hero', 'sidebarFooter', 'approved'] as const
export type SkinSlotName = (typeof SKIN_SLOTS)[number]

/** Heading fonts a skin may pick; the renderer owns each font stack. */
export const SKIN_FONTS = ['system', 'songti', 'kaiti', 'rounded'] as const
export type SkinFont = (typeof SKIN_FONTS)[number]

/**
 * `light` / `dark`: the skin has that one look and the window shows it
 * whatever 明暗 is set; `auto`: it follows 明暗 (tokens apply to both).
 */
export type SkinBase = 'light' | 'dark' | 'auto'
export type SkinTheme = 'light' | 'dark'

/** Resolved colours for a skin's preview card, as `R G B` triplets. */
export interface SkinSwatch {
  canvas: string
  base: string
  raised: string
  text1: string
  text2: string
  brand: string
}

export interface SkinView {
  id: string
  name: string
  author: string
  license: string
  description: string
  official: boolean
  base: SkinBase
  /** Allowlisted semantic tokens → validated values. */
  tokens: Record<string, string>
  /**
   * Per theme the skin can show: every token the skin changes, directly or
   * through a token built on it, at the base theme's value. Exempt zones
   * (conversation text, code, diffs, permission cards, costs, sign-in) set
   * these on their root so they look as without a skin.
   */
  reset: Partial<Record<SkinTheme, Record<string, string>>>
  fonts: { heading: SkinFont }
  /** Slot → `app://skin/<id>/<file>?v=…` (main) or a data: URL (tests). */
  slots: Partial<Record<SkinSlotName, string>>
  preview: Partial<Record<SkinTheme, SkinSwatch>>
}

export type SkinListEntry =
  | { ok: true; id: string; view: SkinView }
  | {
      ok: false
      /** The folder's name under the skins folder. */
      id: string
      name: string
      official: false
      problems: string[]
    }

/** The themes a skin can show. */
export function skinThemes(base: SkinBase): SkinTheme[] {
  return base === 'auto' ? ['light', 'dark'] : [base]
}

// ── The renderer's check (a cached view may have been edited) ──────────────

const TOKEN_NAME = /^--[a-z][a-z0-9-]{0,47}$/
/** Values main produces: triplets, rgb(), shadows, lengths. No url(). */
const TOKEN_VALUE = /^[a-z0-9 .,()/%#-]{1,200}$/i
const SLOT_URL =
  /^(?:app:\/\/skin\/[a-z0-9-]{2,32}\/[A-Za-z0-9][\w.-]{0,63}\.(?:png|webp)(?:\?v=[\w-]{1,32})?|data:image\/(?:png|webp);base64,[A-Za-z0-9+/=]+)$/

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null
}

function tokenTable(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (
      !TOKEN_NAME.test(key) ||
      typeof raw !== 'string' ||
      !TOKEN_VALUE.test(raw) ||
      /url\(|expression/i.test(raw)
    )
      return null
    out[key] = raw
  }
  return out
}

/** A view that passes main's shapes, or null (fall back to no skin). */
export function sanitizeSkinView(raw: unknown): SkinView | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  const id = text(v.id, 32)
  const base = v.base
  if (!id || !SKIN_ID_PATTERN.test(id)) return null
  if (base !== 'light' && base !== 'dark' && base !== 'auto') return null
  const tokens = tokenTable(v.tokens)
  if (!tokens) return null
  const reset: SkinView['reset'] = {}
  const rawReset = (v.reset ?? {}) as Record<string, unknown>
  for (const theme of skinThemes(base)) {
    const table = tokenTable(rawReset[theme] ?? {})
    if (!table) return null
    reset[theme] = table
  }
  const fonts = (v.fonts ?? {}) as Record<string, unknown>
  const heading = SKIN_FONTS.includes(fonts.heading as SkinFont)
    ? (fonts.heading as SkinFont)
    : 'system'
  const slots: SkinView['slots'] = {}
  const rawSlots = (v.slots ?? {}) as Record<string, unknown>
  for (const slot of SKIN_SLOTS) {
    const url = rawSlots[slot]
    if (url === undefined) continue
    if (typeof url !== 'string' || !SLOT_URL.test(url)) return null
    slots[slot] = url
  }
  return {
    id,
    name: text(v.name, 40) || id,
    author: text(v.author, 60) ?? '',
    license: text(v.license, 60) ?? '',
    description: text(v.description, 120) ?? '',
    official: v.official === true,
    base,
    tokens,
    reset,
    fonts: { heading },
    slots,
    preview: previewOf(v.preview),
  }
}

const TRIPLET = /^\d{1,3} \d{1,3} \d{1,3}$/
const SWATCH_KEYS = ['canvas', 'base', 'raised', 'text1', 'text2', 'brand']

function previewOf(value: unknown): SkinView['preview'] {
  const out: SkinView['preview'] = {}
  const raw = (value ?? {}) as Record<string, unknown>
  for (const theme of ['light', 'dark'] as const) {
    const swatch = raw[theme] as Record<string, unknown> | undefined
    if (
      swatch &&
      SWATCH_KEYS.every(
        (key) => typeof swatch[key] === 'string' && TRIPLET.test(swatch[key]),
      )
    )
      out[theme] = Object.fromEntries(
        SWATCH_KEYS.map((key) => [key, swatch[key]]),
      ) as unknown as SkinSwatch
  }
  return out
}
