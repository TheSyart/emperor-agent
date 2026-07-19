const cfg = window.emperorPet || {}
const mapper = window.EmperorPetMapper
const idleScenes = window.EmperorPetIdleScenes
const pet = document.getElementById('pet')
const bubble = document.getElementById('speech-bubble')
const bubbleText = document.getElementById('speech-text')
const badge = document.getElementById('subagent-badge')

let currentAnimation = ''
let resetTimer = null
let pollTimer = null
let bubbleTimer = null
let idleSceneTimer = null
let idleSceneIndex = 0
let subagentCount = 0
let assistantDraft = ''
let pendingInteractionActive = false

function assetUrl(animation) {
  const file = mapper.ASSETS[animation] || mapper.ASSETS.idle
  return `${cfg.assetBaseUrl || ''}${file}`
}

function setAnimation(animation, options = {}) {
  const next = animation || 'idle'
  if (next !== currentAnimation) {
    currentAnimation = next
    pet.src = `${assetUrl(next)}?v=${Date.now()}`
  }
  if (options.idleScene) return
  if (next === 'idle') {
    startIdleLoop()
  } else {
    stopIdleLoop()
  }
}

function canRunIdleLoop() {
  return (
    subagentCount === 0 &&
    !pendingInteractionActive &&
    !['disconnected', 'dizzy'].includes(currentAnimation)
  )
}

function startIdleLoop(delayMs = idleScenes.IDLE_BUBBLE_INTERVAL_MS) {
  if (!canRunIdleLoop() || idleSceneTimer) return
  idleSceneTimer = setTimeout(runIdleScene, delayMs)
}

function stopIdleLoop() {
  if (!idleSceneTimer) return
  clearTimeout(idleSceneTimer)
  idleSceneTimer = null
}

function runIdleScene() {
  idleSceneTimer = null
  if (!canRunIdleLoop()) return
  const scene = idleScenes.idleSceneAt(idleSceneIndex)
  idleSceneIndex += 1
  setAnimation(scene.animation, { idleScene: true })
  showBubble(scene.bubble, scene.bubbleDurationMs)
  if (scene.animation === 'sleeping') {
    idleSceneTimer = setTimeout(() => {
      idleSceneTimer = null
      if (!canRunIdleLoop()) return
      setAnimation(scene.wakeAnimation || 'idle', { idleScene: true })
      startIdleLoop()
    }, scene.durationMs || idleScenes.IDLE_SLEEP_DURATION_MS)
    return
  }
  startIdleLoop()
}

function showBubble(text, durationMs = 3600) {
  const message = String(text || '').trim()
  if (!message) return
  if (bubbleTimer) {
    clearTimeout(bubbleTimer)
    bubbleTimer = null
  }
  bubbleText.textContent = message
  bubble.hidden = false
  if (durationMs > 0) {
    bubbleTimer = setTimeout(() => {
      bubbleTimer = null
      hideBubble()
    }, durationMs)
  }
}

function hideBubble() {
  if (bubbleTimer) {
    clearTimeout(bubbleTimer)
    bubbleTimer = null
  }
  bubble.hidden = true
  bubbleText.textContent = ''
}

function updateBadge(delta) {
  if (!delta) return
  subagentCount = Math.max(0, subagentCount + delta)
  badge.hidden = subagentCount <= 0
  badge.textContent = `×${subagentCount}`
  if (subagentCount > 0) {
    stopIdleLoop()
  } else if (currentAnimation === 'idle') {
    startIdleLoop()
  }
}

function applyRuntimeEvent(event, options = {}) {
  if (!event || typeof event !== 'object') return
  if (['ask_request', 'plan_draft', 'turn_paused'].includes(event.event)) {
    pendingInteractionActive = true
  }
  if (
    ['ask_answered', 'plan_approved', 'interaction_cancelled'].includes(
      event.event,
    )
  ) {
    pendingInteractionActive = false
    if (currentAnimation === 'notification') setAnimation('idle')
  }
  if (event.event === 'user_message') assistantDraft = ''
  const effect = mapper.mapRuntimeEvent(event)
  if (!effect) return
  updateBadge(effect.subagentDelta)
  if (resetTimer) {
    clearTimeout(resetTimer)
    resetTimer = null
  }
  if (effect.animation) setAnimation(effect.animation)
  let nextBubble = effect.bubble
  if (effect.appendAssistantDelta) {
    assistantDraft = `${assistantDraft}${event.delta || ''}`.slice(-600)
    nextBubble = mapper.bubbleForContent(
      '正在回复：',
      assistantDraft,
      effect.bubble || '正在回复。',
    )
  }
  if (!options.replay && nextBubble) {
    showBubble(nextBubble, effect.bubbleDurationMs ?? 3600)
  }
  if (!options.replay && effect.resetAfterMs) {
    resetTimer = setTimeout(() => {
      resetTimer = null
      setAnimation(subagentCount > 0 ? 'conducting' : 'idle')
    }, effect.resetAfterMs)
  }
  if (event.event === 'assistant_done') assistantDraft = ''
}

async function loadBootstrap() {
  try {
    const boot = await cfg.readBootstrap?.()
    for (const event of boot?.runtime?.events || []) {
      applyRuntimeEvent(event, { replay: true })
    }
    const pending = boot?.control?.pending
    if (pending) {
      pendingInteractionActive = true
      setAnimation('notification')
      const kind = pending.kind === 'plan' ? 'plan_draft' : 'ask_request'
      const pendingEffect = mapper.mapRuntimeEvent({
        event: kind,
        interaction: pending,
      })
      showBubble(pendingEffect?.bubble || '需要主人拍板。', 0)
    }
  } catch {
    setAnimation('disconnected')
    showBubble('连接 Agent 事件失败，等待重试。', 4000)
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(async () => {
    try {
      const events = await cfg.readRuntimeEvents?.()
      if (currentAnimation === 'disconnected') {
        hideBubble()
        setAnimation('idle')
      }
      for (const event of events || []) applyRuntimeEvent(event)
    } catch {
      setAnimation('disconnected')
      showBubble('读取本地事件失败，等待重试。', 4000)
    }
  }, 1000)

  // Faster IPC poll for live events from the main process.
  setInterval(async () => {
    try {
      const ipcEvents = await cfg.readIpcEvents?.()
      for (const event of ipcEvents || []) applyRuntimeEvent(event)
    } catch {
      // IPC events are best-effort; the next bootstrap restores recent state.
    }
  }, 200)
}

setAnimation('disconnected')
showBubble('正在连接 Agent 事件。', 2500)
loadBootstrap().finally(() => {
  if (currentAnimation === 'disconnected') setAnimation('idle')
  startPolling()
})
