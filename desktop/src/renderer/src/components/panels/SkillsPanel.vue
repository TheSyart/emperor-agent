<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { SkillInfo } from '../../types'
import { actionIcons, emptyIcons } from '../../icons'
import {
  skillCapability,
  type CapabilityDisplayItem,
} from '../../capabilities/capabilityProjection'
import CapabilityCard from '../capabilities/CapabilityCard.vue'
import MarkdownBlock from '../chat/MarkdownBlock.vue'

const props = defineProps<{
  skills: SkillInfo[]
  activeSkill: string | null
  content: string
}>()
const emit = defineEmits<{
  load: [name: string]
  new: [name: string]
  save: [content: string]
  delete: [name: string]
}>()

const filter = ref('')
const draft = ref('')
const preview = ref(false)
const detailOpen = ref(false)

watch(
  () => props.content,
  (content) => {
    draft.value = content
  },
  { immediate: true },
)
watch(
  () => props.activeSkill,
  (name) => {
    if (name) detailOpen.value = true
  },
  { immediate: true },
)

const filtered = computed(() => {
  const query = filter.value.trim().toLowerCase()
  if (!query) return props.skills
  return props.skills.filter((skill) =>
    `${skill.name} ${skill.description || ''} ${skill.path}`
      .toLowerCase()
      .includes(query),
  )
})
const skillItems = computed(() =>
  filtered.value.map((skill) => skillCapability(skill)),
)

const activeSkillInfo = computed(
  () => props.skills.find((s) => s.name === props.activeSkill) || null,
)

function parseTags(tagStr: string): string[] {
  if (!tagStr) return []
  return tagStr.split(/[,;\s]+/).filter(Boolean)
}

function openSkill(skill: SkillInfo) {
  detailOpen.value = true
  emit('load', skill.name)
}

function openSkillItem(item: CapabilityDisplayItem) {
  const skill = props.skills.find((candidate) => candidate.name === item.name)
  if (!skill) return
  openSkill(skill)
}

function createSkill() {
  const name = window.prompt('技能名称，例如 video-planner')?.trim()
  if (!name) return
  preview.value = false
  detailOpen.value = true
  emit('new', name)
}

function confirmDelete(name: string) {
  if (!window.confirm(`确定要删除 Skill「${name}」吗？此操作不可恢复。`)) return
  detailOpen.value = false
  emit('delete', name)
}
</script>

<template>
  <div
    class="panel-content capability-panel"
    :class="{ 'has-detail': detailOpen && props.activeSkill }"
  >
    <div class="panel-toolbar">
      <div class="filter-wrap">
        <input v-model="filter" placeholder="筛选技能" />
        <span
          v-if="filtered.length !== props.skills.length"
          class="filter-badge"
        >
          {{ filtered.length }} / {{ props.skills.length }}
        </span>
        <span v-else-if="props.skills.length" class="filter-badge">
          共 {{ props.skills.length }} 个
        </span>
      </div>
      <button
        class="tool-button asset-button primary-action"
        @click="createSkill"
      >
        <component :is="actionIcons.new" class="action-icon" :size="16" />
        <span>新增</span>
      </button>
    </div>

    <div class="capability-card-grid panel-scroll">
      <CapabilityCard
        v-for="item in skillItems"
        :key="item.id"
        :item="item"
        :active="props.activeSkill === item.name"
        @select="openSkillItem"
      />
      <div
        v-if="!filtered.length"
        class="empty-state illustrated-empty tool-empty"
      >
        <component :is="emptyIcons.skills" :size="64" :stroke-width="1" />
        <span>还没有发现技能。</span>
      </div>
    </div>

    <aside
      v-if="detailOpen && props.activeSkill"
      class="capability-detail-drawer"
    >
      <div class="capability-drawer-head">
        <div class="min-w-0">
          <h2>{{ props.activeSkill }}</h2>
          <p>{{ activeSkillInfo?.path || 'SKILL.md' }}</p>
        </div>
        <button class="icon-button" title="关闭" @click="detailOpen = false">
          ×
        </button>
      </div>

      <div class="capability-drawer-badges">
        <span
          v-if="activeSkillInfo?.status && activeSkillInfo.status !== 'active'"
          class="badge gold"
        >
          {{ activeSkillInfo.status }}
        </span>
        <span v-if="activeSkillInfo?.always" class="badge gold">always</span>
        <span
          v-for="tag in parseTags(activeSkillInfo?.tags || '')"
          :key="tag"
          class="badge green"
          >{{ tag }}</span
        >
        <span class="badge">md</span>
        <button
          class="badge preview-toggle"
          :class="{ active: preview }"
          @click="preview = !preview"
        >
          {{ preview ? '编辑' : '预览' }}
        </button>
      </div>

      <div v-if="preview" class="skill-preview">
        <MarkdownBlock :content="draft" />
      </div>
      <textarea v-else v-model="draft" class="capability-editor-textarea" />

      <div class="capability-drawer-actions">
        <button
          class="tool-button danger"
          @click="confirmDelete(props.activeSkill)"
        >
          删除
        </button>
        <button
          class="tool-button ink asset-button primary-action"
          @click="emit('save', draft)"
        >
          <component :is="actionIcons.save" class="action-icon" :size="16" />
          <span>保存技能</span>
        </button>
      </div>
    </aside>
  </div>
</template>
