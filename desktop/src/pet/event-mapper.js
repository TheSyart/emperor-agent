;(function expose(factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory()
  } else {
    window.EmperorPetMapper = factory()
  }
})(function buildMapper() {
  /** Every frame is one cell of the 小单 sheet; strips are frames × width. */
  const SPRITE_FRAME = { width: 192, height: 208 }

  /**
   * Horizontal frame strips under assets/desktop-pet/xiaodan. `alternate`
   * plays forward then back, for sequences (a head turn, a facepalm) whose
   * last frame does not lead into the first.
   */
  const SPRITES = {
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
    laptop: {
      file: 'xiaodan-laptop.webp',
      frames: 6,
      fps: 6,
      alternate: false,
    },
    think: { file: 'xiaodan-think.webp', frames: 6, fps: 4, alternate: true },
    lookup: { file: 'xiaodan-lookup.webp', frames: 8, fps: 5, alternate: true },
    lookaround: {
      file: 'xiaodan-lookaround.webp',
      frames: 8,
      fps: 5,
      alternate: true,
    },
    doze: { file: 'xiaodan-doze.webp', frames: 2, fps: 1, alternate: false },
  }

  /** Runtime animation key → sprite strip. */
  const ASSETS = {
    idle: 'idle',
    sleeping: 'doze',
    disconnected: 'lookaround',
    thinking: 'think',
    debugger: 'laptop',
    typing: 'present',
    building: 'run',
    conducting: 'walk',
    wizard: 'lookup',
    beacon: 'laptop',
    sweeping: 'walk',
    notification: 'wave',
    happy: 'cheer',
    dizzy: 'facepalm',
  }

  const ACTIVITY_BUBBLES = {
    thinking: '收到，开始想。',
    replying: '正在回复。',
    reading: '正在查阅资料。',
    editing: '正在整理改动。',
    running: '正在运行命令。',
    delegating: '正在派遣队友。',
    browsing: '正在看看网页。',
    external: '正在呼叫外部工具。',
    scheduling: '正在处理定时任务。',
  }

  function mapPetEvent(event) {
    if (!event || typeof event !== 'object') return null
    if (event.type === 'connection') {
      return event.online
        ? { animation: 'idle' }
        : { animation: 'disconnected', bubble: '连接 Agent 事件失败。' }
    }
    if (event.type === 'activity') {
      const bubble = ACTIVITY_BUBBLES[event.label]
      if (!bubble || !ASSETS[event.animation]) return null
      return {
        animation: event.animation,
        bubble,
        ...(event.subagentDelta ? { subagentDelta: event.subagentDelta } : {}),
      }
    }
    if (event.type === 'attention') {
      if (event.kind === 'approval')
        return {
          animation: 'notification',
          bubble: '需要主人拍板。',
          bubbleDurationMs: 0,
        }
      if (event.kind === 'error')
        return {
          animation: 'dizzy',
          bubble: '这里有点不顺。',
          resetAfterMs: 2000,
        }
      if (event.kind === 'done')
        return {
          animation: 'happy',
          bubble: '办好了。',
          resetAfterMs: 4000,
        }
    }
    return null
  }

  /** The strip an animation key plays; unknown keys fall back to idle. */
  function spriteFor(animation) {
    return SPRITES[ASSETS[animation]] || SPRITES[ASSETS.idle]
  }

  return { ASSETS, SPRITES, SPRITE_FRAME, spriteFor, mapPetEvent }
})
