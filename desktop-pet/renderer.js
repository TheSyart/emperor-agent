const cfg = window.emperorPet || {};
const mapper = window.EmperorPetMapper;
const idleScenes = window.EmperorPetIdleScenes;
const runtimeUrls = window.EmperorPetUrls;
const pet = document.getElementById("pet");
const bubble = document.getElementById("speech-bubble");
const bubbleText = document.getElementById("speech-text");
const badge = document.getElementById("subagent-badge");

let currentAnimation = "";
let resetTimer = null;
let reconnectTimer = null;
let bubbleTimer = null;
let idleSceneTimer = null;
let idleSceneIndex = 0;
let subagentCount = 0;
let lastSeq = 0;
let socket = null;
let assistantDraft = "";
let pendingInteractionActive = false;

function assetUrl(animation) {
  const file = mapper.ASSETS[animation] || mapper.ASSETS.idle;
  return `${cfg.assetBaseUrl || ""}${file}`;
}

function setAnimation(animation, options = {}) {
  const next = animation || "idle";
  if (next !== currentAnimation) {
    currentAnimation = next;
    pet.src = `${assetUrl(next)}?v=${Date.now()}`;
  }
  if (options.idleScene) return;
  if (next === "idle") {
    startIdleLoop();
  } else {
    stopIdleLoop();
  }
}

function canRunIdleLoop() {
  return subagentCount === 0 && !pendingInteractionActive && !["disconnected", "dizzy"].includes(currentAnimation);
}

function startIdleLoop(delayMs = idleScenes.IDLE_BUBBLE_INTERVAL_MS) {
  if (!canRunIdleLoop() || idleSceneTimer) return;
  idleSceneTimer = setTimeout(runIdleScene, delayMs);
}

function stopIdleLoop() {
  if (!idleSceneTimer) return;
  clearTimeout(idleSceneTimer);
  idleSceneTimer = null;
}

function runIdleScene() {
  idleSceneTimer = null;
  if (!canRunIdleLoop()) return;
  const scene = idleScenes.idleSceneAt(idleSceneIndex);
  idleSceneIndex += 1;
  setAnimation(scene.animation, { idleScene: true });
  showBubble(scene.bubble, scene.bubbleDurationMs);
  if (scene.animation === "sleeping") {
    idleSceneTimer = setTimeout(() => {
      idleSceneTimer = null;
      if (!canRunIdleLoop()) return;
      setAnimation(scene.wakeAnimation || "idle", { idleScene: true });
      startIdleLoop();
    }, scene.durationMs || idleScenes.IDLE_SLEEP_DURATION_MS);
    return;
  }
  startIdleLoop();
}

function showBubble(text, durationMs = 3600) {
  const message = String(text || "").trim();
  if (!message) return;
  if (bubbleTimer) {
    clearTimeout(bubbleTimer);
    bubbleTimer = null;
  }
  bubbleText.textContent = message;
  bubble.hidden = false;
  if (durationMs > 0) {
    bubbleTimer = setTimeout(() => {
      bubbleTimer = null;
      hideBubble();
    }, durationMs);
  }
}

function hideBubble() {
  if (bubbleTimer) {
    clearTimeout(bubbleTimer);
    bubbleTimer = null;
  }
  bubble.hidden = true;
  bubbleText.textContent = "";
}

function updateBadge(delta) {
  if (!delta) return;
  subagentCount = Math.max(0, subagentCount + delta);
  badge.hidden = subagentCount <= 0;
  badge.textContent = `×${subagentCount}`;
  if (subagentCount > 0) {
    stopIdleLoop();
  } else if (currentAnimation === "idle") {
    startIdleLoop();
  }
}

function applyRuntimeEvent(event, options = {}) {
  if (!event || typeof event !== "object") return;
  if (Number.isFinite(event.seq)) lastSeq = Math.max(lastSeq, Number(event.seq));
  if (["ask_request", "plan_draft", "turn_paused"].includes(event.event)) {
    pendingInteractionActive = true;
  }
  if (["ask_answered", "plan_approved", "interaction_cancelled"].includes(event.event)) {
    pendingInteractionActive = false;
    if (currentAnimation === "notification") setAnimation("idle");
  }
  if (event.event === "user_message") assistantDraft = "";
  const effect = mapper.mapRuntimeEvent(event);
  if (!effect) return;
  updateBadge(effect.subagentDelta);
  if (resetTimer) {
    clearTimeout(resetTimer);
    resetTimer = null;
  }
  if (effect.animation) setAnimation(effect.animation);
  let nextBubble = effect.bubble;
  if (effect.appendAssistantDelta) {
    assistantDraft = `${assistantDraft}${event.delta || ""}`.slice(-600);
    nextBubble = mapper.bubbleForContent("正在回复：", assistantDraft, effect.bubble || "正在回复。");
  }
  if (!options.replay && nextBubble) {
    showBubble(nextBubble, effect.bubbleDurationMs ?? 3600);
  }
  if (!options.replay && effect.resetAfterMs) {
    resetTimer = setTimeout(() => {
      resetTimer = null;
      setAnimation(subagentCount > 0 ? "conducting" : "idle");
    }, effect.resetAfterMs);
  }
  if (event.event === "assistant_done") assistantDraft = "";
}

function wsUrl() {
  return runtimeUrls.wsUrl(cfg.webuiUrl, lastSeq, cfg.backendToken);
}

async function loadBootstrap() {
  try {
    const response = await fetch(runtimeUrls.apiUrl(cfg.webuiUrl, "/api/bootstrap", cfg.backendToken));
    const boot = await response.json();
    lastSeq = Number(boot?.runtime?.latestSeq || 0);
    const pending = boot?.control?.pending;
    if (pending) {
      pendingInteractionActive = true;
      setAnimation("notification");
      const kind = pending.kind === "plan" ? "plan_draft" : "ask_request";
      const pendingEffect = mapper.mapRuntimeEvent({ event: kind, interaction: pending });
      showBubble(pendingEffect?.bubble || "需要主人拍板。", 0);
    }
  } catch {
    setAnimation("disconnected");
    showBubble("连接断开，正在重连。", 4000);
  }
}

function connectSocket() {
  if (socket) socket.close();
  socket = new WebSocket(wsUrl());
  socket.addEventListener("open", () => {
    if (currentAnimation === "disconnected") hideBubble();
    setAnimation(currentAnimation === "disconnected" ? "idle" : currentAnimation || "idle");
  });
  socket.addEventListener("message", (event) => {
    try {
      applyRuntimeEvent(JSON.parse(event.data));
    } catch {
      // Ignore malformed events from a broken connection.
    }
  });
  socket.addEventListener("close", scheduleReconnect);
  socket.addEventListener("error", scheduleReconnect);
}

function scheduleReconnect() {
  setAnimation("disconnected");
  showBubble("连接断开，正在重连。", 4000);
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectSocket();
  }, 1500);
}

setAnimation("disconnected");
showBubble("正在连接本地服务。", 2500);
loadBootstrap().finally(connectSocket);
