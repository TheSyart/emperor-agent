/**
 * 小单 desktop-pet sprites for Settings › 桌宠. The frame strips live in the
 * shared repo-root `assets/desktop-pet/xiaodan/` directory; `import.meta.glob`
 * (eager, `?url`) makes Vite emit each file and hand back a build-safe URL, so
 * the previews resolve in dev, in the built renderer and inside the packaged
 * app (a runtime-built relative `src` string does not: Vite never sees it and
 * the files 404).
 *
 * The state → strip table mirrors `desktop/src/pet/event-mapper.js`, which the
 * pet window runs as a plain script and Vite cannot import; petSprites.test.ts
 * fails whenever the two drift apart.
 */
const SPRITE_URLS = import.meta.glob<string>(
  '../../../../../../../assets/desktop-pet/xiaodan/*.webp',
  { eager: true, query: '?url', import: 'default' },
)

/** One frame of a strip; a strip is `frames × width` wide. */
export const PET_FRAME = { width: 192, height: 208 } as const

export interface PetStrip {
  file: string
  frames: number
  fps: number
  /** Play forward then back (sequences whose last frame is not a loop). */
  alternate: boolean
}

export interface PetSprite {
  /** Runtime animation key, e.g. `thinking`. */
  id: string
  /** Moment the pet shows it for. */
  label: string
  strip: PetStrip
  url: string
}

const STRIPS = {
  idle: { file: 'xiaodan-idle.webp', frames: 7, fps: 4, alternate: true },
  run: { file: 'xiaodan-run.webp', frames: 8, fps: 12, alternate: false },
  walk: { file: 'xiaodan-walk.webp', frames: 8, fps: 9, alternate: false },
  wave: { file: 'xiaodan-wave.webp', frames: 4, fps: 4, alternate: true },
  cheer: { file: 'xiaodan-cheer.webp', frames: 5, fps: 7, alternate: false },
  facepalm: {
    file: 'xiaodan-facepalm.webp',
    frames: 8,
    fps: 6,
    alternate: true,
  },
  present: {
    file: 'xiaodan-present.webp',
    frames: 6,
    fps: 5,
    alternate: true,
  },
  laptop: { file: 'xiaodan-laptop.webp', frames: 6, fps: 6, alternate: false },
  think: { file: 'xiaodan-think.webp', frames: 6, fps: 4, alternate: true },
  lookup: { file: 'xiaodan-lookup.webp', frames: 8, fps: 5, alternate: true },
  lookaround: {
    file: 'xiaodan-lookaround.webp',
    frames: 8,
    fps: 5,
    alternate: true,
  },
  doze: { file: 'xiaodan-doze.webp', frames: 2, fps: 1, alternate: false },
} as const satisfies Record<string, PetStrip>

/** The 14 runtime states, in the order the pet walks through a turn. */
const STATES: ReadonlyArray<
  readonly [id: string, label: string, strip: keyof typeof STRIPS]
> = [
  ['idle', '待机', 'idle'],
  ['thinking', '思考', 'think'],
  ['typing', '回复', 'present'],
  ['debugger', '查阅文件', 'laptop'],
  ['building', '运行命令', 'run'],
  ['conducting', '派遣队友', 'walk'],
  ['wizard', '查看网页', 'lookup'],
  ['beacon', '外部工具', 'laptop'],
  ['sweeping', '散步', 'walk'],
  ['happy', '完成', 'cheer'],
  ['notification', '等待拍板', 'wave'],
  ['dizzy', '出错', 'facepalm'],
  ['sleeping', '打盹', 'doze'],
  ['disconnected', '断连', 'lookaround'],
]

function stripUrl(file: string): string {
  const entry = Object.entries(SPRITE_URLS).find(([path]) =>
    path.endsWith(`/${file}`),
  )
  return entry?.[1] ?? ''
}

export const PET_SPRITES: readonly PetSprite[] = STATES.map(
  ([id, label, strip]) => ({
    id,
    label,
    strip: STRIPS[strip],
    url: stripUrl(STRIPS[strip].file),
  }),
).filter((sprite) => sprite.url)

export const PET_IDLE_SPRITE_ID = 'idle'

/** Display name of the pet character. */
export const PET_NAME = '小单'
