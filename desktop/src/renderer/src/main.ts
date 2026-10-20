import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import { initTheme } from './composables/useTheme'
// Feature CSS responsibilities and effective cascade order are guarded by
// feature-style-owners.json + featureStyleOwnership.test.ts.
import './styles.css'
import './theme/primitives.css'
import './theme/semantic.dark.css'
import './theme/semantic.light.css'
import './theme/components.css'
import './theme/base.css'
import './styles/a11y.css'
import './styles/activity.css'
import './styles/panels.css'
import './styles/surfaces/menus.css'
import './styles/surfaces/panels.css'
import './styles/workspace.css'
import './styles/files-highlight.css'
import './styles/dsh/animations.css'

// Stored preference (light / dark / system) → resolved data-theme; storage
// failures fall back to the default and `system` follows the OS live.
initTheme()

// Dev-only primitives gallery (`?ui-gallery`): visual testing for the dsh
// design system; tree-shaken out of production builds.
if (
  import.meta.env.DEV &&
  new URLSearchParams(location.search).has('ui-gallery')
) {
  void import('./components/ui/UiGallery.vue').then(({ default: UiGallery }) =>
    createApp(UiGallery).mount('#app'),
  )
} else if (
  import.meta.env.DEV &&
  new URLSearchParams(location.search).has('settings-gallery')
) {
  // Dev-only settings primitives gallery in a mock 564px settings column.
  void import('./components/settings/ui/SettingsGallery.vue').then(
    ({ default: SettingsGallery }) => createApp(SettingsGallery).mount('#app'),
  )
} else if (
  import.meta.env.DEV &&
  new URLSearchParams(location.search).has('chat-gallery')
) {
  // Dev-only chat timeline gallery over in-memory fixture sessions (M4b).
  void import('./components/conversation/gallery/ChatGallery.vue').then(
    ({ default: ChatGallery }) => createApp(ChatGallery).mount('#app'),
  )
} else if (
  import.meta.env.DEV &&
  new URLSearchParams(location.search).has('trajectory-gallery')
) {
  // Dev-only trajectory gallery over in-memory fixture sessions (M7).
  void import('./components/trajectory/gallery/TrajectoryGallery.vue').then(
    ({ default: TrajectoryGallery }) =>
      createApp(TrajectoryGallery).mount('#app'),
  )
} else {
  const app = createApp(App).use(router)
  // Mount once the first navigation (a lazily loaded route) settles: a
  // sidebar click before that would be taken as the first navigation and
  // replace the start entry, leaving 后退 with nowhere to go.
  void router.isReady().finally(() => app.mount('#app'))
}
