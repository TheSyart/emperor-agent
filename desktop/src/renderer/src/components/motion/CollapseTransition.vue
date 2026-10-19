<script setup lang="ts">
/**
 * CollapseTransition — the one disclosure motion of the chat flow (UI-S03,
 * DSH-22): a body opens from 0 to its height while fading in, and closes the
 * same way, in 200ms (`--motion-base`, `--ease-standard`). Process groups,
 * tool rows and thinking rows all use it, so a fold looks the same wherever
 * it happens. Reduced motion has no motion at all; neither do environments
 * without media queries (unit tests).
 *
 * Height is animated on purpose (the style audit's transform/opacity rule
 * covers CSS transitions): the rows below must move with the body.
 *
 * Slot: the conditionally rendered body (one element).
 */
import { prefersReducedMotion } from '../../composables/useReducedMotion'

/** `--motion-base` and `--ease-standard` (theme/primitives.css). */
const DURATION_MS = 200
const EASE = 'cubic-bezier(0.2, 0, 0, 1)'
const MOTION = `height ${DURATION_MS}ms ${EASE}, opacity ${DURATION_MS}ms ${EASE}`

function moving(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    !prefersReducedMotion()
  )
}

function reset(el: Element): void {
  const style = (el as HTMLElement).style
  style.height = ''
  style.opacity = ''
  style.overflow = ''
  style.transition = ''
}

function animate(
  el: HTMLElement,
  from: { height: number; opacity: string },
  to: { height: number; opacity: string },
  done: () => void,
): void {
  el.style.overflow = 'hidden'
  el.style.height = `${from.height}px`
  el.style.opacity = from.opacity
  // Commit the start frame before the transition is set.
  void el.offsetHeight
  el.style.transition = MOTION
  el.style.height = `${to.height}px`
  el.style.opacity = to.opacity
  let finished = false
  const finish = (): void => {
    if (finished) return
    finished = true
    el.removeEventListener('transitionend', onEnd)
    clearTimeout(timer)
    done()
  }
  const onEnd = (event: TransitionEvent): void => {
    if (event.target === el && event.propertyName === 'height') finish()
  }
  el.addEventListener('transitionend', onEnd)
  // transitionend never fires when nothing changed or the tab is hidden.
  const timer = setTimeout(finish, DURATION_MS + 80)
}

function onEnter(el: Element, done: () => void): void {
  if (!moving()) return done()
  const body = el as HTMLElement
  animate(
    body,
    { height: 0, opacity: '0' },
    { height: body.scrollHeight, opacity: '1' },
    done,
  )
}

function onLeave(el: Element, done: () => void): void {
  if (!moving()) return done()
  const body = el as HTMLElement
  animate(
    body,
    { height: body.getBoundingClientRect().height, opacity: '1' },
    { height: 0, opacity: '0' },
    done,
  )
}
</script>

<template>
  <Transition
    :css="false"
    @enter="onEnter"
    @after-enter="reset"
    @enter-cancelled="reset"
    @leave="onLeave"
    @after-leave="reset"
    @leave-cancelled="reset"
  >
    <slot />
  </Transition>
</template>
