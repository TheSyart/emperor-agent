<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { SkillInfo } from '../../types'
import { actionAssets, emptyAssets, toolAssets } from '../../assets'

const props = defineProps<{ skills: SkillInfo[]; activeSkill: string | null; content: string }>()
const emit = defineEmits<{ load: [name: string]; new: [name: string]; save: [content: string] }>()

const filter = ref('')
const draft = ref('')
watch(() => props.content, (content) => { draft.value = content }, { immediate: true })

const filtered = computed(() => {
  const query = filter.value.trim().toLowerCase()
  if (!query) return props.skills
  return props.skills.filter((skill) => `${skill.name} ${skill.description || ''} ${skill.path}`.toLowerCase().includes(query))
})

const activeSkillInfo = computed(() => {
  return props.skills.find((s) => s.name === props.activeSkill) || null
})

function parseTags(tagStr: string): string[] {
  if (!tagStr) return []
  return tagStr.split(/[,;\s]+/).filter(Boolean)
}

function createSkill() {
  const name = window.prompt('Skill 名称，例如 video-planner')?.trim()
  if (name) emit('new', name)
}
</script>

<template>
  <div class="panel-content split-panel">
    <div class="panel-toolbar">
      <div class="filter-wrap">
        <input v-model="filter" placeholder="筛选 skill" />
        <span v-if="filtered.length !== props.skills.length" class="filter-badge">
          {{ filtered.length }} / {{ props.skills.length }}
        </span>
        <span v-else-if="props.skills.length" class="filter-badge">
          共 {{ props.skills.length }} 个
        </span>
      </div>
      <button class="tool-button asset-button primary-action" @click="createSkill">
        <img class="action-icon" :src="actionAssets.new" alt="" width="18" height="18" />
        <span>新增</span>
      </button>
    </div>

    <div class="split-body">
      <div class="resource-list skill-list">
        <button
          v-for="skill in filtered"
          :key="skill.name"
          class="list-item skill-card"
          :class="{ active: props.activeSkill === skill.name }"
          @click="emit('load', skill.name)"
        >
          <img class="resource-icon" :src="toolAssets.skill" alt="" width="34" height="34" />
          <div class="min-w-0 flex-1">
            <div class="skill-header">
              <div class="item-title">{{ skill.name }}</div>
              <div class="badge-row">
                <span v-if="skill.always" class="badge gold">always</span>
                <span class="badge">md</span>
              </div>
            </div>
            <div class="item-desc">{{ skill.description || '暂无描述' }}</div>
            <div v-if="skill.path" class="skill-path">{{ skill.path }}</div>
            <div v-if="parseTags(skill.tags || '').length" class="skill-tags">
              <span v-for="tag in parseTags(skill.tags || '')" :key="tag" class="badge green">{{ tag }}</span>
            </div>
          </div>
        </button>
        <div v-if="!filtered.length" class="empty-note illustrated-empty compact-illustration">
          <img :src="emptyAssets.skills" alt="" />
          <span>还没有发现 skill。</span>
        </div>
      </div>

      <div v-if="!props.activeSkill" class="empty-state illustrated-empty">
        <img :src="emptyAssets.skills" alt="" />
        <span>选择一个 skill，或新建一个能力包。</span>
      </div>
      <div v-else class="editor skill-editor">
        <div class="editor-title skill-editor-header">
          <div class="skill-editor-meta">
            <span class="skill-editor-name">{{ props.activeSkill }}</span>
            <span class="skill-editor-file">SKILL.md</span>
          </div>
          <div class="skill-editor-badges">
            <span v-if="activeSkillInfo?.always" class="badge gold">always</span>
            <span v-for="tag in parseTags(activeSkillInfo?.tags || '')" :key="tag" class="badge green">{{ tag }}</span>
            <span class="badge">md</span>
          </div>
        </div>
        <textarea v-model="draft" />
        <div class="editor-actions">
          <span class="status-pill">保存后刷新 system prompt</span>
          <button class="tool-button ink asset-button primary-action" @click="emit('save', draft)">
            <img class="action-icon" :src="actionAssets.save" alt="" width="18" height="18" />
            <span>保存 skill</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
