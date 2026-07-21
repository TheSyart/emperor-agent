import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import { applyTheme, DEFAULT_THEME } from './theme/tokens'
import './styles.css'
import './theme/dark.css'
import './theme/light.css'
import './theme/base.css'
import './styles/layout.css'
import './styles/chat.css'
import './styles/activity.css'
import './styles/panels.css'
import './styles/responsive.css'
import './styles/codex-v2.css'

applyTheme(document, localStorage.getItem('emperor.theme') ?? DEFAULT_THEME)

createApp(App).use(router).mount('#app')
