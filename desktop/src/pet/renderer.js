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

function applyPetEvent(event) {
  if (!event || typeof event !== 'object') return
  if (event.type === 'attention' && event.kind === 'approval') {
    pendingInteractionActive = true
  }
  if (event.type === 'attention' && event.kind !== 'approval') {
    pendingInteractionActive = false
    if (currentAnimation === 'notification') setAnimation('idle')
  }
  const effect = mapper.mapPetEvent(event)
  if (!effect) return
  updateBadge(effect.subagentDelta)
  if (resetTimer) {
    clearTimeout(resetTimer)
    resetTimer = null
  }
  if (effect.animation) setAnimation(effect.animation)
  if (effect.bubble) showBubble(effect.bubble, effect.bubbleDurationMs ?? 3600)
  if (effect.resetAfterMs) {
    resetTimer = setTimeout(() => {
      resetTimer = null
      setAnimation(subagentCount > 0 ? 'conducting' : 'idle')
    }, effect.resetAfterMs)
  }
}

async function loadBootstrap() {
  try {
    const boot = await cfg.readBootstrap?.()
    if (boot?.event) applyPetEvent(boot.event)
  } catch {
    setAnimation('disconnected')
    showBubble('连接 Agent 事件失败，等待重试。', 4000)
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(async () => {
    try {
      const events = await cfg.readPetEvents?.()
      if (currentAnimation === 'disconnected') {
        hideBubble()
        setAnimation('idle')
      }
      for (const event of events || []) applyPetEvent(event)
    } catch {
      applyPetEvent({ type: 'connection', online: false })
    }
  }, 200)
}

setAnimation('disconnected')
showBubble('正在连接 Agent 事件。', 2500)
loadBootstrap().finally(() => {
  if (currentAnimation === 'disconnected') setAnimation('idle')
  startPolling()
})
