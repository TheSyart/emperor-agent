/**
 * Full pages stay alive in App.vue's `<keep-alive>`, so a page (or a section
 * inside one) that loads on mount would otherwise keep showing the data of
 * its first visit. `onPageReactivated(fn)` runs `fn` each time the page is
 * shown again after having been hidden — never on the first mount, which the
 * caller already loads itself. Outside a kept-alive tree it never fires.
 *
 * It keys off a real deactivation rather than skipping the first `activated`
 * call: a component mounted inside an already-active page (a tab body, an
 * async chunk) gets no activation of its own until the page is re-shown.
 */
import { onActivated, onDeactivated } from 'vue'

export function onPageReactivated(fn: () => unknown): void {
  let hidden = false
  onDeactivated(() => {
    hidden = true
  })
  onActivated(() => {
    if (!hidden) return
    hidden = false
    void fn()
  })
}
