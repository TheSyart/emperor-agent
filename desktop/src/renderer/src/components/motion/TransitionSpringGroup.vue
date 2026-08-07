<script setup lang="ts">
import { computed } from 'vue'
import { useReducedMotion } from '../../composables/useReducedMotion'

// Staggered list enter/exit, the group counterpart to AppTransition. Each
// entering child slides up + fades in with a small per-index delay so a list
// reads as items arriving in sequence rather than a single block. Motion runs
// on transform + opacity only (compositor path) and collapses to a fast fade
// under prefers-reduced-motion. Used for the message stream, sidebar session
// list, and palette results.
//
// The parent must give each child a stable :key. `stagger` is the per-index
// delay in ms; `appear` runs the stagger on initial mount.

const props = withDefaults(
  defineProps<{
    /** Per-index stagger delay in ms. */
    stagger?: number
    /** Cap on total stagger so very long lists don't feel sluggish. */
    maxStagger?: number
    /** Run the enter transition on initial mount. */
    appear?: boolean
    /** Tag rendered by TransitionGroup. */
    tag?: string
  }>(),
  { stagger: 24, maxStagger: 240, appear: false, tag: undefined },
)

const reducedMotion = useReducedMotion()

const easingOut = 'cubic-bezier(0.22, 1, 0.36, 1)'
const easingIn = 'cubic-bezier(0.32, 0, 0.67, 0)'

const enterDuration = computed(() => (reducedMotion.value ? 140 : 240))
const leaveDuration = computed(() => (reducedMotion.value ? 120 : 180))

function delayFor(el: Element): number {
  if (reducedMotion.value) return 0
  const index = Number((el as HTMLElement).dataset.staggerIndex ?? 0)
  return Math.min(index * props.stagger, props.maxStagger)
}

function setEnterFrom(el: HTMLElement): void {
  el.style.willChange = 'transform, opacity'
  if (reducedMotion.value) {
    el.style.opacity = '0'
    return
  }
  el.style.opacity = '0'
  el.style.transform = 'translateY(12px)'
}

function onBeforeEnter(el: Element): void {
  setEnterFrom(el as HTMLElement)
}

function onEnter(el: Element, done: () => void): void {
  const target = el as HTMLElement
  const delay = delayFor(target)
  void target.offsetWidth
  target.style.transition = [
    `opacity ${enterDuration.value}ms ${easingOut} ${delay}ms`,
    `transform ${enterDuration.value}ms ${easingOut} ${delay}ms`,
  ].join(', ')
  target.style.opacity = '1'
  target.style.transform = 'none'
  const total = enterDuration.value + delay
  const onEnd = () => {
    cleanup(target)
    done()
  }
  target.addEventListener('transitionend', onEnd, { once: true })
  window.setTimeout(onEnd, total + 60)
}

function onBeforeLeave(el: Element): void {
  const target = el as HTMLElement
  target.style.willChange = 'transform, opacity'
}

function onLeave(el: Element, done: () => void): void {
  const target = el as HTMLElement
  target.style.transition = [
    `opacity ${leaveDuration.value}ms ${easingIn}`,
    reducedMotion.value ? '' : `transform ${leaveDuration.value}ms ${easingIn}`,
  ]
    .filter(Boolean)
    .join(', ')
  void target.offsetWidth
  target.style.opacity = '0'
  if (!reducedMotion.value) target.style.transform = 'translateY(6px)'
  const onEnd = () => {
    cleanup(target)
    done()
  }
  target.addEventListener('transitionend', onEnd, { once: true })
  window.setTimeout(onEnd, leaveDuration.value + 60)
}

function cleanup(el: HTMLElement): void {
  el.style.opacity = ''
  el.style.transform = ''
  el.style.transition = ''
  el.style.willChange = ''
}
</script>

<template>
  <TransitionGroup
    :tag="tag"
    :appear="appear"
    :css="false"
    @before-enter="onBeforeEnter"
    @enter="onEnter"
    @before-leave="onBeforeLeave"
    @leave="onLeave"
  >
    <slot />
  </TransitionGroup>
</template>
