<script setup lang="ts">
/**
 * ConversationHeader — dsh conversation header (l2 hairline). Its first row
 * is the center panel's 46px top bar (UI-S01: bottoms line up with the rail,
 * sidebar and workspace bars, and its empty space moves the window): the
 * breadcrumb (project / ancestors / current title; ancestor crumbs
 * navigate) with the right-hand toggles — 环境信息 (the chat
 * environment card, Chat tab only; a floating-card glyph so it does not read
 * as "about") and 工作台 (the right workspace column) — then, only while
 * 显示轨迹 is on (`trajectory`, UI-S09), the 对话 | 轨迹 tab strip (13/16
 * medium, gap 36, 2px gold bar); off, the header is that one row.
 * `slim` (the empty hero phase) renders the 工作台 toggle only, so a new chat
 * can still open the workspace (the browser works for a draft); the
 * environment card has nothing to show before the first message and stays
 * hidden there, so its toggle does too.
 */
import { computed } from 'vue'
import { PanelRight, PictureInPicture2 } from 'lucide-vue-next'
import Avatar from '../ui/Avatar.vue'
import IconButton from '../ui/IconButton.vue'
import Tabs from '../ui/Tabs.vue'
import type { HeaderCrumb } from './conversationModel'

const emit = defineEmits<{
  navigate: [sessionId: string]
  tab: [tab: 'chat' | 'trajectory']
  'toggle-workspace': []
  'toggle-env-card': []
}>()

const props = defineProps<{
  crumbs: HeaderCrumb[]
  tab: 'chat' | 'trajectory'
  workspaceOpen: boolean
  envCardOpen: boolean
  tabsDisabled?: boolean
  slim?: boolean
  /** The 轨迹 tab is available (设置 › 常规 › 开发者 › 显示轨迹). */
  trajectory?: boolean
}>()

const tabs = computed(() =>
  (
    [
      { id: 'chat', label: '对话' },
      { id: 'trajectory', label: '轨迹' },
    ] as const
  ).map((item) => ({
    ...item,
    disabled: Boolean(props.tabsDisabled) && item.id !== props.tab,
  })),
)

function onTab(id: string) {
  if (id === 'chat' || id === 'trajectory') emit('tab', id)
}
</script>

<template>
  <header class="conversation-header" :data-slim="slim || undefined">
    <div class="title-row" data-app-drag>
      <nav v-if="!slim" class="crumbs" aria-label="会话路径">
        <template v-for="(crumb, index) in crumbs" :key="crumb.id">
          <span v-if="index > 0" class="sep" aria-hidden="true">/</span>
          <Avatar
            kind="sprite"
            v-if="crumb.nativeSessionId"
            :id="crumb.nativeSessionId"
            :size="24"
          />
          <button
            v-if="crumb.sessionId && !crumb.current"
            type="button"
            class="crumb"
            :data-subagent="crumb.subagent || undefined"
            :title="crumb.label"
            @click="emit('navigate', crumb.sessionId)"
          >
            {{ crumb.label }}
          </button>
          <span
            v-else
            class="crumb"
            :data-current="crumb.current || undefined"
            :data-subagent="crumb.subagent || undefined"
            :title="crumb.label"
            :aria-current="crumb.current ? 'page' : undefined"
            >{{ crumb.label }}</span
          >
          <span v-if="crumb.source" class="source-badge">{{
            crumb.source
          }}</span>
        </template>
      </nav>
      <div class="actions">
        <slot name="actions" />
        <IconButton
          v-if="tab === 'chat' && !slim"
          label="环境信息"
          :active="envCardOpen"
          :aria-pressed="envCardOpen"
          @click="emit('toggle-env-card')"
        >
          <PictureInPicture2 :size="16" />
        </IconButton>
        <IconButton
          label="工作台"
          :active="workspaceOpen"
          :aria-pressed="workspaceOpen"
          @click="emit('toggle-workspace')"
        >
          <PanelRight :size="16" />
        </IconButton>
      </div>
    </div>
    <Tabs
      v-if="trajectory && !slim"
      class="tabs"
      aria-label="会话视图"
      :tabs="tabs"
      :model-value="tab"
      @update:model-value="onTab"
    />
  </header>
</template>

<style scoped>
.source-badge {
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
}

.conversation-header {
  position: relative;
  flex: none;
  padding: 0 var(--space-3) 0 var(--space-5);
}

.conversation-header::after {
  content: '';
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 1px;
  background: var(--border-l2);
  pointer-events: none;
}

/* Hero phase: toggles only, floating over the centered hero (no hairline,
   no layout shift). */
.conversation-header[data-slim] {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
  z-index: var(--z-raised);
  pointer-events: none;
}

.conversation-header[data-slim]::after {
  content: none;
}

.conversation-header[data-slim] .actions {
  pointer-events: auto;
}

.title-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  box-sizing: border-box;
  height: var(--shell-bar-h);
}

.crumbs {
  display: flex;
  flex: 1;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}

.sep {
  flex: none;
  color: rgb(var(--label-caption));
  font-size: var(--fs-s);
  line-height: var(--space-5);
}

.crumb {
  min-width: 0;
  max-width: 220px;
  overflow: hidden;
  padding: var(--space-1) var(--space-2);
  border: none;
  border-radius: var(--radius-card);
  background: transparent;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-s);
  line-height: var(--space-5);
  text-overflow: ellipsis;
  white-space: nowrap;
}

button.crumb {
  cursor: pointer;
}

button.crumb:hover {
  background: var(--interactive-bg-hover);
  color: rgb(var(--label-secondary));
}

.crumb[data-subagent] {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.crumb[data-current] {
  flex: 0 1 auto;
  max-width: none;
  color: rgb(var(--label-primary));
  font-weight: 500;
}

.actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-2);
  margin-left: auto;
}

.tabs {
  position: relative;
  z-index: var(--z-raised);
  gap: calc(var(--space-8) + var(--space-1));
  margin-top: var(--space-1);
  padding-left: var(--space-2);
}

/* The header keeps its compact 28px strip. */
.tabs :deep(.tab) {
  height: var(--space-7);
}
</style>
