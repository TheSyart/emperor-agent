import { ref, type Ref } from 'vue'
import type { ChatMessage } from '../../types'

export function messageScrollSignature(messages: ChatMessage[]): string {
  const last = messages[messages.length - 1]
  if (!last) return '0'
  if (last.role === 'user') {
    return [
      messages.length,
      last.id,
      last.content.length,
      last.attachments?.length ?? 0,
      last.source ?? '',
    ].join(':')
  }
  return [
    messages.length,
    last.id,
    last.content.length,
    last.segments.length,
    last.todos?.length ?? 0,
    last.streaming ? 1 : 0,
  ].join(':')
}

export const FOLLOW_BOTTOM_THRESHOLD_PX = 80

/** 滚动锁定（Wave4.1）：离底部超过阈值即解锁自动跟随，回到底部附近重新锁定。 */
export function shouldFollowBottom(el: {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}): boolean {
  return (
    el.scrollHeight - el.scrollTop - el.clientHeight <=
    FOLLOW_BOTTOM_THRESHOLD_PX
  )
}

export const VIRTUALIZE_THRESHOLD = 120

/** 虚拟滚动（Wave6）：短会话保持普通 v-for（零回归），长会话切 DynamicScroller。 */
export function shouldVirtualize(messageCount: number): boolean {
  return messageCount >= VIRTUALIZE_THRESHOLD
}

export const APPEND_BATCH_LIMIT = 4

/**
 * 仅追加判定（Stage5 消息流 stagger）：前缀一致且尾部增量 <= 4 才算"新消息到达"。
 * 会话切换 / 历史装载 / 替换 / 删除都会破坏前缀或超出增量 → 返回 false,
 * 调用方据此 remount 消息栈(静默呈现),避免 TransitionGroup 对整批旧行触发进场风暴。
 */
export function isAppendChange(
  prev: ChatMessage[] | undefined,
  next: ChatMessage[],
): boolean {
  if (!prev) return false
  const delta = next.length - prev.length
  if (delta < 0 || delta > APPEND_BATCH_LIMIT) return false
  return prev.every((message, index) => next[index]?.id === message.id)
}

export interface ExpansionStore {
  isOpen(key: string, fallback: boolean): boolean
  setOpen(key: string, open: boolean): void
  version: Ref<number>
}

/**
 * 展开态提升（Wave6）：<details>/折叠面板的展开状态按稳定 key 存在组件树之外，
 * 虚拟滚动卸载重挂不丢展开；version 供 DynamicScrollerItem size-dependencies 触发重测。
 */
export function createExpansionStore(): ExpansionStore {
  const states = new Map<string, boolean>()
  const version = ref(0)
  return {
    isOpen(key: string, fallback: boolean): boolean {
      const value = states.get(key)
      return value === undefined ? fallback : value
    },
    setOpen(key: string, open: boolean): void {
      if (states.get(key) === open) return
      states.set(key, open)
      version.value += 1
    },
    version,
  }
}
