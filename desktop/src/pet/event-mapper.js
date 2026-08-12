;(function expose(factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory()
  } else {
    window.EmperorPetMapper = factory()
  }
})(function buildMapper() {
  const ASSETS = {
    idle: 'clawd-idle-living.svg',
    sleeping: 'clawd-sleeping.svg',
    disconnected: 'clawd-disconnected.svg',
    thinking: 'clawd-working-thinking.svg',
    debugger: 'clawd-working-debugger.svg',
    typing: 'clawd-working-typing.svg',
    building: 'clawd-working-building.svg',
    conducting: 'clawd-working-conducting.svg',
    wizard: 'clawd-working-wizard.svg',
    beacon: 'clawd-working-beacon.svg',
    sweeping: 'clawd-working-sweeping.svg',
    notification: 'clawd-notification.svg',
    happy: 'clawd-happy.svg',
    dizzy: 'clawd-dizzy.svg',
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

  return { ASSETS, mapPetEvent }
})
