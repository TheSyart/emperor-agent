<script setup lang="ts">
/**
 * Sidebar primary row (UI-S11, per mode since MOD-02): the raised 36px ⌘N
 * button — 新对话 / 新建项目会话 / 新建群聊 — showing ⌘N on hover, and in
 * Build and Group a + beside it (打开文件夹 / 新建联系人). The button runs
 * what ⌘N runs (`new-session`); the pages moved to the footer (D4).
 *
 * Group's two entries wait for GRP-04 / GRP-05: they stay in place, marked
 * unavailable (`aria-disabled`, not `disabled`, so the hover still says
 * 「即将推出」) and do nothing.
 */
import { computed, ref } from 'vue'
import type { AppMode } from '../../runtime/appMode'
import { detectShortcutPlatform, shortcutLabel } from '../../shortcuts'
import IconButton from '../ui/IconButton.vue'
import Kbd from '../ui/Kbd.vue'
import TooltipBubble from '../ui/TooltipBubble.vue'
import { useTooltip } from '../ui/useTooltip'
import { COMING_SOON, modeEntry } from './modeEntries'

const props = defineProps<{ mode: AppMode }>()
const emit = defineEmits<{ 'new-session': []; secondary: [] }>()

const entry = computed(() => modeEntry(props.mode))
const primary = computed(() => entry.value.primary)
const secondary = computed(() => entry.value.secondary)
const newShortcut = shortcutLabel('session.new', detectShortcutPlatform())

const primaryButton = ref<HTMLButtonElement | null>(null)
const soon = useTooltip({
  anchor: primaryButton,
  side: () => 'bottom',
  delayMs: () => 400,
  enabled: () => !primary.value.ready,
})

function runPrimary(): void {
  if (primary.value.ready) emit('new-session')
}

function runSecondary(): void {
  if (secondary.value?.ready) emit('secondary')
}
</script>

<template>
  <nav class="sidebar-nav" aria-label="侧栏导航">
    <div class="new-chat-row" data-sidebar-block="new">
      <button
        ref="primaryButton"
        type="button"
        class="new-chat"
        :aria-label="primary.label"
        :aria-disabled="primary.ready ? undefined : 'true'"
        @click="runPrimary"
        v-on="soon.listeners"
      >
        <component :is="primary.icon" :size="16" class="new-chat-icon" />
        <span class="new-chat-label">{{ primary.label }}</span>
        <Kbd v-if="newShortcut && primary.ready" class="new-chat-key">{{
          newShortcut
        }}</Kbd>
        <TooltipBubble
          v-if="soon.visible.value"
          :label="COMING_SOON"
          :side="soon.side.value"
          :position="soon.position.value"
        />
      </button>
      <IconButton
        v-if="secondary"
        class="nav-add"
        :label="secondary.label"
        :tooltip="secondary.ready ? secondary.label : COMING_SOON"
        :aria-disabled="secondary.ready ? undefined : 'true'"
        size="sm"
        @click="runSecondary"
      >
        <component :is="secondary.icon" :size="16" />
      </IconButton>
    </div>
  </nav>
</template>

<style scoped>
.sidebar-nav {
  display: flex;
  flex: none;
  flex-direction: column;
  margin-bottom: var(--space-3);
}

/* The ⌘N button: the one raised object in the sidebar. */
.new-chat-row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.new-chat {
  position: relative;
  display: flex;
  flex: 1;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  height: 36px;
  padding: 0 var(--space-3);
  border: none;
  border-radius: var(--r-md);
  background: rgb(var(--surface-raised));
  box-shadow: var(--elev-1);
  color: rgb(var(--text-1));
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: var(--weight-medium);
  text-align: left;
  cursor: pointer;
  transition: box-shadow var(--motion-base) var(--ease-standard);
}

.new-chat:hover:not([aria-disabled='true']) {
  box-shadow: var(--elev-2);
}

.new-chat:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

/* Not built yet (Group): still there, quieter, nothing happens. */
.new-chat[aria-disabled='true'],
.nav-add[aria-disabled='true'] {
  cursor: default;
}

.new-chat[aria-disabled='true'] .new-chat-icon,
.new-chat[aria-disabled='true'] .new-chat-label,
.nav-add[aria-disabled='true'] {
  opacity: 0.45;
}

.new-chat-icon {
  flex: none;
  color: rgb(var(--text-2));
}

.new-chat-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.new-chat-key {
  flex: none;
  font-size: var(--fs-xxs);
  font-weight: var(--weight-regular);
  color: rgb(var(--text-3));
  opacity: 0;
  transition: opacity var(--motion-base) var(--ease-standard);
}

.new-chat:hover .new-chat-key,
.new-chat:focus-visible .new-chat-key {
  opacity: 1;
}

.nav-add {
  flex: none;
  color: rgb(var(--text-3));
}
</style>
