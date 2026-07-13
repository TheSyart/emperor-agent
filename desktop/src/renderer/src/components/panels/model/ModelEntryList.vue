<script setup lang="ts">
import type { ModelEntry } from '../../../types'
import { actionIcons, modelIcons } from '../../../icons'

defineProps<{
  entries: ModelEntry[]
  defaultName: string
  editingIndex: number
}>()

const emit = defineEmits<{
  add: []
  pick: [index: number]
  setActive: [index: number]
}>()
</script>

<template>
  <aside class="entry-list-pane">
    <header class="entry-list-head">
      <div class="entry-list-title">
        <span>模型条目</span>
        <small>{{ entries.length }} 条</small>
      </div>
      <button class="tool-button compact" @click="emit('add')">
        <component :is="actionIcons.new" :size="14" />
        <span>添加</span>
      </button>
    </header>
    <div class="entry-list">
      <div
        v-for="(entry, idx) in entries"
        :key="idx"
        class="entry-item"
        :class="{
          active: idx === editingIndex,
          default: entry.name === defaultName,
        }"
        @click="emit('pick', idx)"
      >
        <div class="entry-meta">
          <div class="entry-title">
            <span>{{ entry.label || entry.name }}</span>
            <span
              v-if="entry.supportsVision"
              class="entry-vision-eye"
              title="此条目已通过视觉测试，可接收图片附件"
              aria-label="视觉已激活"
            >
              <component :is="modelIcons.vision" :size="14" />
            </span>
          </div>
          <div class="entry-sub">
            <code>{{ entry.provider }}</code> ·
            <code>{{ entry.mainModelId || entry.id || '(no main)' }}</code>
            /
            <code :class="{ 'text-seal': !entry.secondaryModelId }">{{
              entry.secondaryModelId || '需补次模型'
            }}</code>
          </div>
        </div>
        <span
          v-if="entry.name === defaultName"
          class="entry-active-badge"
          title="此条目当前为激活状态"
          >激活</span
        >
        <button
          v-else
          class="entry-activate-btn"
          title="切换为激活条目（保存后生效）"
          @click.stop="emit('setActive', idx)"
        >
          设为激活
        </button>
      </div>
    </div>
  </aside>
</template>
