<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import Avatar from './Avatar.vue'
import { subagentFrames, subagentSheet } from './subagentAvatars'
import { createAvatarPreviewPlayer } from './avatarPreview'
// Same approved order as the visual reference; coprime stride visits all 36.
const start = subagentFrames.findIndex((frame) => frame.id === 'C07')
const frames = subagentFrames.map(
  (_, i) => subagentFrames[(start + i * 13) % subagentFrames.length]!,
)
const current = ref(0),
  next = ref(1),
  container = ref<HTMLElement>(),
  first = ref<HTMLElement>(),
  second = ref<HTMLElement>(),
  failed = ref(false)
let dispose: (() => void) | undefined
onMounted(() => {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  const player = createAvatarPreviewPlayer({
    count: frames.length,
    hidden: document.hidden || !document.hasFocus(),
    reduced: reduced?.matches,
    decode: () =>
      Promise.all(
        [...new Set(frames.map((frame) => frame.group))].map((group) => {
          const image = new Image()
          image.src = subagentSheet(group)
          return image.decode()
        }),
      ),
    request: (cb) => requestAnimationFrame(cb),
    cancel: (id) => cancelAnimationFrame(id),
    failed: () => {
      failed.value = true
    },
    paint(pose, staticOnly) {
      current.value = staticOnly && pose.mix >= 0.5 ? pose.next : pose.current
      next.value = pose.next
      if (container.value)
        container.value.dataset.currentPortrait = frames[current.value]!.id
      for (const [layer, opacity, scale] of [
        [
          first.value,
          staticOnly ? 1 : 1 - pose.mix,
          staticOnly ? 1 : pose.currentScale,
        ],
        [
          second.value,
          staticOnly ? 0 : pose.mix,
          staticOnly ? 1 : pose.nextScale,
        ],
      ] as const) {
        if (layer) {
          layer.style.opacity = String(opacity)
          layer.style.transform = `scale(${scale})`
        }
      }
    },
  })
  // Electron can keep document.hidden=false for a hidden native window.
  // Focus is an additional settings-only pause signal; the player keeps time.
  const visibility = () =>
      player.setHidden(document.hidden || !document.hasFocus()),
    blur = () => player.setHidden(true),
    motion = () => player.setReducedMotion(reduced?.matches ?? false)
  document.addEventListener('visibilitychange', visibility)
  window.addEventListener('focus', visibility)
  window.addEventListener('blur', blur)
  reduced?.addEventListener('change', motion)
  dispose = () => {
    player.destroy()
    document.removeEventListener('visibilitychange', visibility)
    window.removeEventListener('focus', visibility)
    window.removeEventListener('blur', blur)
    reduced?.removeEventListener('change', motion)
  }
})
onBeforeUnmount(() => dispose?.())
</script>
<template>
  <span
    ref="container"
    class="avatar-preview"
    data-avatar-preview
    :title="failed ? '角色头像预览加载失败' : undefined"
    :data-preview-error="failed || undefined"
    role="img"
    :aria-label="
      failed ? '本地角色头像预览加载失败' : '本地子智能体角色头像预览'
    "
  >
    <span ref="first" class="layer" aria-hidden="true"
      ><Avatar
        kind="sprite"
        id="settings-preview"
        :frame-id="frames[current]!.id"
        :size="40"
    /></span>
    <span ref="second" class="layer" aria-hidden="true"
      ><Avatar
        kind="sprite"
        id="settings-preview"
        :frame-id="frames[next]!.id"
        :size="40"
    /></span>
  </span>
</template>
<style scoped>
.avatar-preview {
  position: relative;
  display: inline-block;
  width: 40px;
  height: 40px;
  flex: none;
  background: transparent;
}
.layer {
  position: absolute;
  inset: 0;
  display: flex;
}
.layer + .layer {
  opacity: 0;
}
</style>
