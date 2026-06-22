import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import { brandAssets } from './assets'
import './styles.css'
import './styles/layout.css'
import './styles/chat.css'
import './styles/activity.css'
import './styles/panels.css'
import './styles/responsive.css'

const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
if (favicon) favicon.href = brandAssets.favicon

createApp(App).use(router).mount('#app')
