<script setup lang="ts">
/**
 * GroupInterimPage — `/groups/:groupId` until the group page arrives
 * (GRP-05; GRP-08 replaces it with the conversation, the composer, the
 * members and the group's settings): the group's name, its members and
 * moderator, and every message as `groups.history` gives it — who said it,
 * to whom when private, and the text — read again on `groups_changed`.
 * Sending, stopping and settings are not here yet.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { CoreOperationResult } from '@emperor/core/api'
import { onCoreEvent } from '../../api/backend'
import { core } from '../../api/http'
import { failureText } from '../contacts/contactEditorModel'
import Button from '../ui/Button.vue'
import EmptyState from '../ui/EmptyState.vue'
import Notice from '../ui/Notice.vue'

type GroupView = CoreOperationResult<'groups.get'>
type GroupMessage = CoreOperationResult<'groups.history'>['messages'][number]

const route = useRoute()
const router = useRouter()

const groupId = computed(() => String(route.params.groupId ?? ''))
const group = ref<GroupView | null>(null)
const messages = ref<GroupMessage[]>([])
const gone = ref(false)
const loadError = ref('')
let generation = 0

async function load() {
  const id = groupId.value
  const run = ++generation
  try {
    const [view, history] = await Promise.all([
      core('groups.get', { id }),
      core('groups.history', { id, limit: 500 }),
    ])
    if (run !== generation) return
    group.value = view
    messages.value = history.messages
    gone.value = false
    loadError.value = ''
  } catch (error) {
    if (run !== generation) return
    group.value = null
    messages.value = []
    if ((error as { code?: string }).code === 'group_not_found')
      gone.value = true
    else loadError.value = failureText(error)
  }
}

watch(groupId, (id) => id && void load(), { immediate: true })

let timer: ReturnType<typeof setTimeout> | null = null
const unsubscribe = onCoreEvent((input) => {
  const event = input as { event?: string; group_id?: string } | null
  if (event?.event !== 'groups_changed' || event.group_id !== groupId.value)
    return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void load()
  }, 80)
})
onBeforeUnmount(() => {
  unsubscribe()
  if (timer) clearTimeout(timer)
})

const names = computed(
  () =>
    new Map(
      (group.value?.members ?? []).map((member) => [member.id, member.name]),
    ),
)
const moderatorName = computed(() =>
  group.value?.moderator ? names.value.get(group.value.moderator) : undefined,
)

function speaker(from: string): string {
  if (from === 'user') return '你'
  if (from === 'system') return '系统'
  return names.value.get(from) ?? '已删除的联系人'
}

function mark(message: GroupMessage): string {
  if (message.audience.kind === 'private')
    return `私信 → ${speaker(message.audience.to)}`
  if (message.hidden) return '独立作答，答完一起显示'
  if (message.kind === 'pass') return '没有补充'
  if (message.kind === 'summary') return '结论'
  if (message.kind === 'task') return '交办'
  if (message.kind === 'result') return '交付'
  return ''
}

function time(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(
    date.getMinutes(),
  ).padStart(2, '0')}`
}

function backHome() {
  void router.push({ name: 'contacts' }).catch(() => undefined)
}
</script>

<template>
  <div class="group-page" data-group-page>
    <EmptyState
      v-if="gone"
      title="没有找到这个群"
      description="它可能已被删除。"
    >
      <Button size="sm" @click="backHome">回到群聊首页</Button>
    </EmptyState>
    <Notice
      v-else-if="loadError"
      tone="error"
      title="群没有打开"
      :description="loadError"
    />
    <template v-else-if="group">
      <header class="bar">
        <h1 class="title">{{ group.title }}</h1>
        <span class="muted">{{ group.members.length }} 人</span>
        <span v-if="moderatorName" class="muted">{{ moderatorName }} 主持</span>
        <span class="members">{{
          group.members.map((member) => member.name).join('、')
        }}</span>
      </header>
      <div class="scroll">
        <Notice
          tone="info"
          title="群聊页面即将推出"
          description="这里先列出群里的消息；在群里发消息、看成员状态、停止和群设置在下一步加入。"
        />
        <ol class="messages">
          <li
            v-for="message in messages"
            :key="message.id"
            class="message"
            :data-group-message="message.id"
            :data-private="message.audience.kind === 'private' || undefined"
          >
            <span class="who">
              <b data-from>{{ speaker(message.from) }}</b>
              <span v-if="mark(message)" class="mark">{{ mark(message) }}</span>
              <span class="time">{{ time(message.at) }}</span>
            </span>
            <p class="text" data-text>{{ message.text }}</p>
          </li>
        </ol>
        <p v-if="!messages.length" class="empty">群里还没有消息。</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.group-page {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  background: rgb(var(--surface-base));
  color: rgb(var(--text-1));
}

.bar {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2-5);
  min-height: 50px;
  padding: var(--space-2-5) var(--space-5);
  box-shadow: inset 0 -0.5px 0 var(--hairline);
}

.title {
  margin: 0;
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: var(--weight-semibold);
}

.muted,
.members {
  color: rgb(var(--text-3));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.members {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.scroll {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-4);
  min-height: 0;
  padding: var(--space-4) var(--space-6) var(--space-8);
  overflow-y: auto;
}

.messages {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  max-width: 780px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.message {
  display: flex;
  flex-direction: column;
  gap: var(--space-0-5);
}

.message[data-private] .text {
  padding-left: var(--space-2-5);
  box-shadow: inset 2px 0 0 rgb(var(--info));
  color: rgb(var(--text-2));
}

.who {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.mark,
.time {
  color: rgb(var(--text-3));
}

.text {
  margin: 0;
  font-size: var(--fs-s);
  line-height: var(--lh-base);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.empty {
  margin: 0;
  color: rgb(var(--text-3));
  font-size: var(--fs-xs);
}
</style>
