<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { Search, X } from 'lucide-vue-next'
import AppTransition from '../motion/AppTransition.vue'

export interface CommandCenterItem {
  id: string
  label: string
  description: string
  meta?: string
  disabled?: boolean
  disabledReason?: string
}

const props = defineProps<{
  open: boolean
  title: string
  description?: string
  items: CommandCenterItem[]
  searchable?: boolean
}>()
const emit = defineEmits<{
  close: []
  select: [item: CommandCenterItem]
}>()
const query = ref('')
const input = ref<HTMLInputElement | null>(null)
const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return props.items
  return props.items.filter((item) =>
    `${item.label} ${item.description} ${item.meta ?? ''}`
      .toLowerCase()
      .includes(needle),
  )
})

watch(
  () => props.open,
  (open) => {
    if (!open) return
    query.value = ''
    void nextTick(() => input.value?.focus())
  },
)

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="command-center-backdrop scrim"
      @mousedown.self="emit('close')"
      @keydown="onKeydown"
    >
      <AppTransition preset="materialize" appear>
        <section
          class="command-center-dialog material-3"
          role="dialog"
          aria-modal="true"
          :aria-label="title"
        >
          <header>
            <div>
              <h2>{{ title }}</h2>
              <p v-if="description">{{ description }}</p>
            </div>
            <button type="button" aria-label="关闭" @click="emit('close')">
              <X :size="16" />
            </button>
          </header>
          <label v-if="searchable !== false" class="command-search">
            <Search :size="15" />
            <input ref="input" v-model="query" placeholder="搜索" />
          </label>
          <div class="command-center-list">
            <button
              v-for="item in filtered"
              :key="item.id"
              type="button"
              class="command-center-item"
              :disabled="item.disabled"
              @click="emit('select', item)"
            >
              <span class="command-center-copy">
                <strong>{{ item.label }}</strong>
                <small>{{ item.description }}</small>
                <small
                  v-if="item.disabledReason"
                  class="command-disabled-reason"
                >
                  {{ item.disabledReason }}
                </small>
              </span>
              <span v-if="item.meta" class="command-center-meta">{{
                item.meta
              }}</span>
            </button>
            <p v-if="!filtered.length" class="command-center-empty">没有匹配项</p>
          </div>
        </section>
      </AppTransition>
    </div>
  </Teleport>
</template>

<style scoped>
/* 遮罩色由 .scrim 提供(--scrim-a);此处只留布局与层级。 */
.command-center-backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: grid;
  place-items: start center;
  padding: max(10vh, 72px) var(--space-6) var(--space-6);
}

/* 表面(背景/blur/阴影/发丝边)由 .material-3 提供;此处只留结构与圆角。 */
.command-center-dialog {
  width: min(680px, 100%);
  max-height: min(720px, 78vh);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: var(--radius-xl);
}

header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-3) var(--space-2);
}

h2 {
  margin: 0;
  font-size: var(--font-size-xl);
  font-weight: 650;
}
p {
  margin: var(--space-1) 0 0;
  color: rgb(var(--fg-muted));
  font-size: var(--font-size-sm);
}
header button {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: var(--radius-md);
  color: rgb(var(--fg-muted));
  background: transparent;
  transition:
    background-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}
header button:hover {
  color: rgb(var(--fg));
  background: rgb(var(--bg-inset));
}

.command-search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0 var(--space-3) var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid rgb(var(--border));
  border-radius: var(--radius);
  color: rgb(var(--fg-muted));
  background: rgb(var(--bg-inset));
}
.command-search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  color: rgb(var(--fg));
  background: transparent;
}

.command-center-list {
  overflow: auto;
  padding: 0 var(--space-2) var(--space-2);
}
.command-center-item {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 0;
  border-radius: var(--radius);
  text-align: left;
  color: rgb(var(--fg));
  background: transparent;
  transition: background-color var(--duration-fast) var(--ease-out);
}
.command-center-item:hover:not(:disabled),
.command-center-item:focus-visible {
  background: rgb(var(--bg-inset));
}
.command-center-item:disabled {
  opacity: 0.48;
}
.command-center-copy {
  min-width: 0;
  display: grid;
  gap: var(--space-1);
}
.command-center-copy strong {
  font:
    600 var(--font-size-md) / 1.35 ui-monospace,
    SFMono-Regular,
    monospace;
}
.command-center-copy small {
  color: rgb(var(--fg-muted));
  font-size: var(--font-size-xs);
}
.command-center-copy small.command-disabled-reason {
  color: rgb(var(--warn));
}
.command-center-meta {
  flex: none;
  color: rgb(var(--fg-muted));
  font-size: var(--font-size-2xs);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.command-center-empty {
  padding: var(--space-4) var(--space-3);
  text-align: center;
}
</style>
