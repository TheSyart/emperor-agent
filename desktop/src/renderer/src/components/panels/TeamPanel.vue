<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { core } from '../../api/http'
import { useAppContext } from '../../composables/useAppContext'
import type { TeamMember, TeamMemberPayload, TeamPayload } from '../../types'
import { avatarIcons, toolIcon } from '../../icons'

const ctx = useAppContext()
const selectedName = ref('')
const detail = ref<TeamMemberPayload | null>(null)
const loading = ref(false)
const messageDraft = ref('')
const createName = ref('')
const createRole = ref('coder')
const createTask = ref('')

const team = computed<TeamPayload>(() => ctx.boot.value?.team || { members: [], leadInbox: [] })
const members = computed(() => team.value.members || [])
const selected = computed(() => members.value.find((member) => member.name === selectedName.value) || null)
const timeline = computed(() => {
  if (!detail.value) return []
  const rows = [...(detail.value.inbox || []), ...(detail.value.leadInbox || [])]
    .filter((msg) => msg.to === selectedName.value || msg.from === selectedName.value)
    .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
  return rows.slice(-80)
})

onMounted(async () => {
  await refreshTeam()
})

watch(members, () => {
  if (!selectedName.value && members.value.length) selectedName.value = members.value[0].name
  if (selectedName.value && !members.value.some((member) => member.name === selectedName.value)) {
    selectedName.value = members.value[0]?.name || ''
  }
}, { immediate: true })

watch(selectedName, async (name) => {
  if (name) await loadMember(name)
  else detail.value = null
})

async function refreshTeam() {
  loading.value = true
  try {
    const payload = await core<TeamPayload>('team.get')
    if (ctx.boot.value) ctx.boot.value.team = payload
    if (!selectedName.value && payload.members?.length) selectedName.value = payload.members[0].name
    if (selectedName.value) await loadMember(selectedName.value)
  } finally {
    loading.value = false
  }
}

async function loadMember(name: string) {
  detail.value = await core<TeamMemberPayload>('team.getMember', name)
}

async function createMember() {
  const name = createName.value.trim()
  const role = createRole.value.trim()
  if (!name || !role) return
  loading.value = true
  try {
    const payload = await core<{ result: string; team: TeamPayload }>('team.spawnMember', { name, role, task: createTask.value.trim() || null })
    if (ctx.boot.value) ctx.boot.value.team = payload.team
    selectedName.value = name
    createName.value = ''
    createTask.value = ''
    ctx.showToast(`队友 ${name} 已入列`)
    await loadMember(name)
  } finally {
    loading.value = false
  }
}

async function sendMessage() {
  if (!selected.value || !messageDraft.value.trim()) return
  loading.value = true
  try {
    const payload = await core<{ result: string; team: TeamPayload }>('team.sendMessage', { to: selected.value.name, content: messageDraft.value.trim(), wake: true })
    if (ctx.boot.value) ctx.boot.value.team = payload.team
    messageDraft.value = ''
    await loadMember(selected.value.name)
  } finally {
    loading.value = false
  }
}

async function wakeMember() {
  if (!selected.value) return
  loading.value = true
  try {
    const payload = await core<{ result: string; team: TeamPayload }>('team.wakeMember', selected.value.name, {})
    if (ctx.boot.value) ctx.boot.value.team = payload.team
    await loadMember(selected.value.name)
  } finally {
    loading.value = false
  }
}

async function shutdownMember() {
  if (!selected.value) return
  loading.value = true
  try {
    const payload = await core<{ result: string; team: TeamPayload }>('team.shutdownMember', selected.value.name)
    if (ctx.boot.value) ctx.boot.value.team = payload.team
    await loadMember(selected.value.name)
  } finally {
    loading.value = false
  }
}

function statusLabel(status?: string) {
  if (status === 'idle') return '空闲'
  if (status === 'working') return '办差中'
  if (status === 'offline') return '离线'
  if (status === 'shutdown') return '已关闭'
  if (status === 'error') return '异常'
  return status || '未知'
}

function messageTitle(msg: { from: string; to: string; type: string }) {
  if (msg.to === 'lead') return `${msg.from} 回禀`
  if (msg.from === 'lead') return `Lead 指令`
  return `${msg.from} → ${msg.to}`
}

function formatTime(ts?: number) {
  if (!ts) return ''
  return new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false })
}

function memberClasses(member: TeamMember) {
  return ['team-member-row', member.status, { active: member.name === selectedName.value }]
}
</script>

<template>
  <div class="panel-content team-panel">
    <div class="team-layout">
      <section class="team-roster">
        <div class="team-section-head">
          <div>
            <h2>队列</h2>
            <p>{{ members.length }} 名队友 · Lead 未读 {{ team.leadUnread || 0 }}</p>
          </div>
          <button class="icon-button" title="刷新" :disabled="loading" @click="refreshTeam">↻</button>
        </div>

        <div class="team-member-list">
          <button
            v-for="member in members"
            :key="member.name"
            :class="memberClasses(member)"
            @click="selectedName = member.name"
          >
            <component :is="avatarIcons.subagent" class="team-avatar" :size="22" />
            <span class="min-w-0 flex-1">
              <strong>{{ member.name }}</strong>
              <small>{{ member.role }} · {{ member.agent_type }}</small>
            </span>
            <em>{{ statusLabel(member.status) }}</em>
          </button>
        </div>

        <form class="team-create" @submit.prevent="createMember">
          <div class="team-form-row">
            <input v-model="createName" placeholder="name" autocomplete="off" />
            <select v-model="createRole">
              <option value="coder">coder</option>
              <option value="reviewer">reviewer</option>
              <option value="researcher">researcher</option>
              <option value="reader">reader</option>
              <option value="runner">runner</option>
            </select>
          </div>
          <textarea v-model="createTask" rows="3" placeholder="initial task" />
          <button class="tool-button wide ink" :disabled="loading || !createName.trim()">召入队友</button>
        </form>
      </section>

      <section class="team-timeline">
        <div class="team-section-head">
          <div>
            <h2>{{ selected?.name || 'Team' }}</h2>
            <p>{{ selected ? `${selected.role} · ${selected.agent_type}` : '暂无队友' }}</p>
          </div>
          <span v-if="selected" class="team-status-pill" :class="selected.status">{{ statusLabel(selected.status) }}</span>
        </div>

        <div class="team-message-scroll">
          <article
            v-for="msg in timeline"
            :key="msg.id"
            class="team-message"
            :class="[msg.type, msg.to === 'lead' ? 'to-lead' : 'to-member']"
          >
            <div class="team-message-top">
              <strong>{{ messageTitle(msg) }}</strong>
              <span>{{ formatTime(msg.timestamp) }}</span>
            </div>
            <p>{{ msg.content }}</p>
          </article>
          <div v-if="!timeline.length" class="team-empty">
            <component :is="avatarIcons.subagent" :size="56" :stroke-width="1" />
            <span>尚无队友消息。</span>
          </div>
        </div>
      </section>

      <aside class="team-detail">
        <div class="team-section-head">
          <div>
            <h2>调度</h2>
            <p>{{ selected?.thread_count || detail?.thread?.length || 0 }} 条上下文片段</p>
          </div>
        </div>

        <div v-if="selected" class="team-detail-body">
          <div class="team-stamp">
            <component :is="avatarIcons.subagent" :size="44" :stroke-width="1" />
            <div class="min-w-0">
              <strong>{{ selected.name }}</strong>
              <span>{{ selected.role }}</span>
            </div>
          </div>

          <div class="team-tool-cloud">
            <span v-for="tool in selected.tools || detail?.member.tools || []" :key="tool">
              <component :is="toolIcon(tool)" :size="14" />
              {{ tool }}
            </span>
          </div>

          <textarea v-model="messageDraft" rows="5" placeholder="send message" />
          <div class="team-action-row">
            <button class="tool-button ink" :disabled="loading || !messageDraft.trim()" @click="sendMessage">发送并唤醒</button>
            <button class="tool-button" :disabled="loading" @click="wakeMember">唤醒</button>
            <button class="tool-button danger" :disabled="loading" @click="shutdownMember">关闭</button>
          </div>

          <div v-if="selected.last_error" class="team-error">{{ selected.last_error }}</div>
        </div>

        <div v-else class="team-detail-body muted">
          <p>Team roster is empty.</p>
        </div>
      </aside>
    </div>
  </div>
</template>
