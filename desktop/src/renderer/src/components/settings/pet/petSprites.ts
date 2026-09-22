/**
 * Clawd desktop-pet sprites for Settings › 桌宠. The SVGs live in the shared
 * repo-root `assets/desktop-pet/clawd-tank/` directory; `import.meta.glob`
 * (eager, `?url`) makes Vite emit / inline each file and hand back a
 * build-safe URL, so the previews resolve in dev, in the built renderer and
 * inside the packaged app (a runtime-built relative `src` string does not:
 * Vite never sees it and the files 404).
 */
const SPRITE_URLS = import.meta.glob<string>(
  '../../../../../../../assets/desktop-pet/clawd-tank/*.svg',
  { eager: true, query: '?url', import: 'default' },
)

export interface PetSprite {
  /** File stem, e.g. `clawd-idle-living`. */
  id: string
  /** Runtime state the pet shows it for. */
  label: string
  url: string
}

/** The 14 runtime states, in the order the pet walks through a turn. */
const SPRITE_LABELS: ReadonlyArray<readonly [id: string, label: string]> = [
  ['clawd-idle-living', '待机'],
  ['clawd-working-thinking', '思考'],
  ['clawd-working-typing', '回复'],
  ['clawd-working-debugger', '查阅文件'],
  ['clawd-working-building', '运行命令'],
  ['clawd-working-conducting', '派遣队友'],
  ['clawd-working-wizard', '查看网页'],
  ['clawd-working-beacon', '外部工具'],
  ['clawd-working-sweeping', '扫除'],
  ['clawd-happy', '完成'],
  ['clawd-notification', '等待拍板'],
  ['clawd-dizzy', '出错'],
  ['clawd-sleeping', '睡觉'],
  ['clawd-disconnected', '断连'],
]

function spriteUrl(id: string): string {
  const entry = Object.entries(SPRITE_URLS).find(([path]) =>
    path.endsWith(`/${id}.svg`),
  )
  return entry?.[1] ?? ''
}

export const PET_SPRITES: readonly PetSprite[] = SPRITE_LABELS.map(
  ([id, label]) => ({ id, label, url: spriteUrl(id) }),
).filter((sprite) => sprite.url)

export const PET_IDLE_SPRITE_ID = 'clawd-idle-living'
