<script setup lang="ts">
/** The real tool trace of one member session belonging to this group. */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { onCoreEvent } from '../../api/backend'
import { core } from '../../api/http'
import {
  chatSnapshotOf,
  createConversationAssembler,
} from '../../conversation/chatSnapshot'
import { toolView } from '../conversation/tools/registry'
import Avatar from '../ui/Avatar.vue'
import IconButton from '../ui/IconButton.vue'
import { contactAvatarProps } from '../contacts/contactAvatar'
import type { Contact } from '@emperor/core/api'
import type { GroupMemberView } from './groupModel'

const props = defineProps<{
  member: GroupMemberView
  contact?: Contact
  groupTitle: string
}>()
const emit = defineEmits<{ back: [] }>()
const loading = ref(true)
const failed = ref('')
const trace = ref<
  Array<{ key: string; title: string; summary: string; status: string }>
>([])
const avatar = computed(() =>
  props.contact
    ? contactAvatarProps(props.contact.avatar, props.contact.name)
    : { kind: 'initials' as const, label: props.member.name },
)
const assembler = createConversationAssembler()
let generation = 0
let timer: ReturnType<typeof setTimeout> | null = null

async function load(): Promise<void> {
  const sessionId = props.member.memberSessionId
  if (!sessionId) {
    generation += 1
    trace.value = []
    failed.value = ''
    loading.value = false
    return
  }
  const run = ++generation
  loading.value = true
  try {
    const page = await core('sessions.history', { sessionId, maxMessages: 50 })
    if (run !== generation) return
    assembler.replaceWindow(page.events, false)
    assembler.flush()
    const snapshot = chatSnapshotOf(assembler)
    trace.value = [...snapshot.nodes.values()].flatMap((node) => {
      if (node.kind !== 'tool') return []
      const view = toolView(node.data.name, node.data)
      return [
        {
          key: node.key,
          title: view.title(node.data),
          summary: view.summary(node.data),
          status: node.data.status === 'running' ? '执行中' : '已完成',
        },
      ]
    })
    failed.value = ''
  } catch (error) {
    if (run === generation)
      failed.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (run === generation) loading.value = false
  }
}
function schedule(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void load()
  }, 80)
}
watch(
  () => props.member.memberSessionId,
  () => void load(),
  { immediate: true },
)
const unsubscribe = onCoreEvent((input) => {
  const event = (input ?? {}) as { session_id?: string; event?: string }
  if (
    event.session_id === props.member.memberSessionId &&
    ['tool_call', 'tool_result', 'assistant_done', 'error'].includes(
      event.event ?? '',
    )
  )
    schedule()
})
onBeforeUnmount(() => {
  unsubscribe()
  if (timer) clearTimeout(timer)
  generation += 1
})
</script>

<template>
  <section
    class="activity"
    data-member-activity
    :data-session-id="member.memberSessionId"
  >
    <div class="top">
      <IconButton label="返回任务进度" @click="emit('back')">‹</IconButton
      ><span>只读</span>
    </div>
    <div class="person">
      <Avatar v-bind="avatar" :size="40" />
      <div>
        <h2>{{ member.name }}</h2>
        <p>本群执行详情</p>
      </div>
    </div>
    <p class="boundary">
      仅显示「{{
        groupTitle
      }}」的成员会话。<br />不包含私人单聊、主记忆或其他群。
    </p>
    <p v-if="loading" class="muted">读取执行记录…</p>
    <p v-else-if="failed" class="muted">{{ failed }}</p>
    <p v-else-if="!trace.length" class="muted">本群会话还没有工具记录。</p>
    <ol v-else class="trace" data-member-trace>
      <li v-for="item in trace" :key="item.key">
        <div>
          <b>{{ item.title }}</b
          ><span>{{ item.status }}</span>
        </div>
        <p>{{ item.summary }}</p>
      </li>
    </ol>
    <p class="note">这里只有真实会话记录，不提供聊天输入或成员操控。</p>
  </section>
</template>

<style scoped>
.activity {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-height: 0;
}
.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
}
.person {
  display: flex;
  align-items: center;
  gap: var(--space-2-5);
}
.person h2 {
  margin: 0;
  font-size: var(--fs-s);
  font-weight: var(--weight-semibold);
}
.person p {
  margin: 0;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
}
.boundary {
  margin: 0;
  padding: var(--space-2);
  border-radius: var(--r-sm);
  background: rgb(var(--info-soft));
  color: rgb(var(--info));
  font-size: var(--fs-xxs);
  line-height: var(--lh-s);
}
.muted,
.note {
  margin: 0;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-s);
}
.trace {
  display: grid;
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}
.trace li {
  min-width: 0;
  padding-bottom: var(--space-2-5);
  box-shadow: inset 0 -0.5px 0 var(--hairline);
}
.trace li > div {
  display: flex;
  gap: var(--space-2);
}
.trace b {
  font-size: var(--fs-xs);
  font-weight: var(--weight-medium);
}
.trace span {
  margin-left: auto;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxxs);
}
.trace p {
  margin: var(--space-1) 0 0;
  overflow-wrap: anywhere;
  color: rgb(var(--text-2));
  font-size: var(--fs-xxs);
}
.note {
  padding-top: var(--space-2);
  box-shadow: inset 0 0.5px 0 var(--hairline);
}
</style>
