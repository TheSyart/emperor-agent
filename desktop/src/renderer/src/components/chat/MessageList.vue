<script setup lang="ts">
import { computed, nextTick, provide, ref, watch } from 'vue'
// @ts-expect-error vue-virtual-scroller v2 beta 无类型声明（见 shims）
import { DynamicScroller, DynamicScrollerItem } from 'vue-virtual-scroller'
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css'
import type { ChatMessage, RuntimePlanRecord } from '../../types'
import MessageRow from './MessageRow.vue'
import { CHAT_EXPANSION_STORE_KEY } from './expansionStoreKey'
import {
  createExpansionStore,
  messageScrollSignature,
  shouldFollowBottom,
  shouldVirtualize,
} from './messageListModel'
import wordmarkUrl from '../../../../../../assets/generated/emperoragent-wordmark.png'

const props = defineProps<{
  messages: ChatMessage[]
  plans?: RuntimePlanRecord[]
}>()
const emit = defineEmits<{ continueExecution: [] }>()
const scroller = ref<HTMLElement | null>(null)
const followBottom = ref(true)

// Wave6：展开态提升——虚拟卸载重挂不丢 <details> 展开，version 触发行高重测
const expansion = createExpansionStore()
provide(CHAT_EXPANSION_STORE_KEY, expansion)

const virtualized = computed(() => shouldVirtualize(props.messages.length))

function pinToBottom() {
  const el = scroller.value
  if (el) el.scrollTop = el.scrollHeight
}

function onScroll() {
  const el = scroller.value
  if (el) followBottom.value = shouldFollowBottom(el)
}

function resumeFollow() {
  followBottom.value = true
  pinToBottom()
}

watch(
  () => messageScrollSignature(props.messages),
  () => {
    if (followBottom.value) void nextTick(pinToBottom)
  },
  { flush: 'post' },
)

// 用户自己发出的新消息总是回到底部（即使此前在翻旧记录）
watch(
  () => {
    const last = props.messages[props.messages.length - 1]
    return last && last.role === 'user' ? last.id : ''
  },
  (id) => {
    if (id) resumeFollow()
  },
  { flush: 'post' },
)

function sizeDependencies(message: ChatMessage): unknown[] {
  if (message.role === 'user') {
    return [
      message.content.length,
      message.attachments?.length ?? 0,
      expansion.version.value,
    ]
  }
  return [
    message.content.length,
    message.segments.length,
    message.streaming,
    message.todos?.length ?? 0,
    expansion.version.value,
  ]
}
</script>

<template>
  <section ref="scroller" class="messages-pane" @scroll.passive="onScroll">
    <div v-if="!props.messages.length" class="welcome-card animate-rise-in">
      <div class="welcome-brand-lockup" aria-label="emperoragent">
        <img
          :src="wordmarkUrl"
          class="welcome-wordmark"
          alt="emperoragent"
          draggable="false"
        />
      </div>
      <div class="welcome-layout">
        <div>
          <h1>把任务交给本地 Agent。</h1>
          <p>
            从代码修改、资料整理到长期提醒，都在独立会话里推进；需要时会调用工具、队友和记忆，留下清晰的执行轨迹。
          </p>
        </div>
      </div>
    </div>

    <DynamicScroller
      v-if="virtualized"
      class="message-stack"
      :items="props.messages"
      key-field="id"
      :min-item-size="56"
      page-mode
    >
      <template #default="{ item, active }">
        <DynamicScrollerItem
          :item="item"
          :active="active"
          :size-dependencies="sizeDependencies(item)"
        >
          <div class="message-stack-virtual-row">
            <MessageRow
              :message="item"
              :plans="props.plans || []"
              @continue-execution="emit('continueExecution')"
            />
          </div>
        </DynamicScrollerItem>
      </template>
    </DynamicScroller>
    <div v-else class="message-stack">
      <MessageRow
        v-for="message in props.messages"
        :key="message.id"
        :message="message"
        :plans="props.plans || []"
        @continue-execution="emit('continueExecution')"
      />
    </div>

    <button
      v-if="!followBottom && props.messages.length"
      type="button"
      class="scroll-to-bottom-btn"
      aria-label="回到底部"
      @click="resumeFollow"
    >
      回到底部 ↓
    </button>
  </section>
</template>
