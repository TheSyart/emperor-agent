import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import { brandAssets } from './assets'
import './styles.css'

const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
if (favicon) favicon.href = brandAssets.favicon

createApp(App).use(router).mount('#app')
