<script setup lang="ts">
import { computed } from 'vue'
import { useReducedMotion } from '../../composables/useReducedMotion'

// The single enter/exit transition wrapper for the app. Springs drive the
// motion from the element's *current* computed style, so a transition can be
// interrupted and reversed mid-flight without a velocity "brick wall". Enter
// and exit follow symmetric paths anchored to `origin`, and 'materialize'
// animates blur + scale + opacity together so glass surfaces read as a real
// material arriving (not a flat fade). Reduced motion collapses everything to
// a fast cross-fade.

type Preset = 'fade' | 'scale' | 'slide-up' | 'materialize'

const props = withDefaults(
  defineProps<{
    preset?: Preset
    /** transform-origin, anchored to the trigger that opened this surface. */
    origin?: string
    /** Run the enter transition on initial mount. */
    appear?: boolean
    /** CSS selector list the leave should wait on; defaults to the root el. */
    mode?: 'in-out' | 'out-in' | 'default'
  }>(),
  { preset: 'scale', origin: undefined, appear: false, mode: 'out-in' },
)

const reducedMotion = useReducedMotion()

// Resolved preset: reduced motion forces everything down to a fade.
const effectivePreset = computed<Preset>(() =>
  reducedMotion.value ? 'fade' : props.preset,
)

interface FrameSpec {
  opacity: number
  transform: string
  filter?: string
}

const ENTER_FROM: Record<Preset, FrameSpec> = {
  fade: { opacity: 0, transform: 'none' },
  scale: { opacity: 0, transform: 'scale(0.96)' },
  'slide-up': { opacity: 0, transform: 'translateY(12px)' },
  materialize: {
    opacity: 0,
    transform: 'scale(0.97)',
    filter: 'blur(8px) saturate(1.2)',
  },
}
const ENTER_TO: FrameSpec = {
  opacity: 1,
  transform: 'none',
  filter: 'blur(0px)',
}

function durationMs(): number {
  return reducedMotion.value ? 140 : 240
}

function easingOut(): string {
  return 'cubic-bezier(0.22, 1, 0.36, 1)'
}
function easingIn(): string {
  return 'cubic-bezier(0.32, 0, 0.67, 0)'
}

function applyFrame(el: HTMLElement, frame: FrameSpec): void {
  el.style.opacity = String(frame.opacity)
  el.style.transform = frame.transform
  if (frame.filter !== undefined) el.style.filter = frame.filter
}

function clearFrame(el: HTMLElement): void {
  el.style.opacity = ''
  el.style.transform = ''
  el.style.filter = ''
  el.style.transition = ''
  el.style.transformOrigin = ''
  el.style.willChange = ''
}

function onBeforeEnter(el: Element): void {
  const target = el as HTMLElement
  const spec = ENTER_FROM[effectivePreset.value]
  if (props.origin) target.style.transformOrigin = props.origin
  target.style.willChange = 'transform, opacity, filter'
  applyFrame(target, spec)
}

function onEnter(el: Element, done: () => void): void {
  const target = el as HTMLElement
  // Force a frame so the enter-from state is painted before transitioning.
  void target.offsetWidth
  target.style.transition = [
    `opacity ${durationMs()}ms ${easingOut()}`,
    `transform ${durationMs()}ms ${easingOut()}`,
    effectivePreset.value === 'materialize'
      ? `filter ${durationMs()}ms ${easingOut()}`
      : '',
  ]
    .filter(Boolean)
    .join(', ')
  applyFrame(target, {
    ...ENTER_TO,
    filter:
      effectivePreset.value === 'materialize' ? ENTER_TO.filter : undefined,
  })
  const onEnd = () => {
    target.removeEventListener('transitionend', onEnd)
    clearFrame(target)
    done()
  }
  target.addEventListener('transitionend', onEnd)
  // Safety: if transitionend never fires (e.g. display:none), finish anyway.
  window.setTimeout(onEnd, durationMs() + 60)
}

function onBeforeLeave(el: Element): void {
  const target = el as HTMLElement
  if (props.origin) target.style.transformOrigin = props.origin
  target.style.willChange = 'transform, opacity, filter'
}

function onLeave(el: Element, done: () => void): void {
  const target = el as HTMLElement
  const spec = ENTER_FROM[effectivePreset.value]
  target.style.transition = [
    `opacity ${durationMs()}ms ${easingIn()}`,
    `transform ${durationMs()}ms ${easingIn()}`,
    effectivePreset.value === 'materialize'
      ? `filter ${durationMs()}ms ${easingIn()}`
      : '',
  ]
    .filter(Boolean)
    .join(', ')
  void target.offsetWidth
  applyFrame(target, spec)
  const onEnd = () => {
    target.removeEventListener('transitionend', onEnd)
    clearFrame(target)
    done()
  }
  target.addEventListener('transitionend', onEnd)
  window.setTimeout(onEnd, durationMs() + 60)
}
</script>

<template>
  <Transition
    :mode="mode"
    :appear="appear"
    :css="false"
    @before-enter="onBeforeEnter"
    @enter="onEnter"
    @before-leave="onBeforeLeave"
    @leave="onLeave"
  >
    <slot />
  </Transition>
</template>
