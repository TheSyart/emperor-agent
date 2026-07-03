import type { InjectionKey } from 'vue'
import type { ExpansionStore } from './messageListModel'

/** Wave6：跨虚拟滚动持久的折叠面板展开态（MessageList provide，Tool 卡片 inject）。 */
export const CHAT_EXPANSION_STORE_KEY: InjectionKey<ExpansionStore> = Symbol('chatExpansionStore')
