<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { Search, X } from 'lucide-vue-next'

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
      class="command-center-backdrop"
      @mousedown.self="emit('close')"
      @keydown="onKeydown"
    >
      <section
        class="command-center-dialog"
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
              <small v-if="item.disabledReason" class="command-disabled-reason">
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
    </div>
  </Teleport>
</template>

<style scoped>
.command-center-backdrop {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: grid;
  place-items: start center;
  padding: max(10vh, 72px) 24px 24px;
  background: rgb(var(--shadow-color) / 0.5);
  backdrop-filter: blur(8px);
}

.command-center-dialog {
  width: min(680px, 100%);
  max-height: min(720px, 78vh);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid rgb(var(--border));
  border-radius: var(--radius-xl);
  background: rgb(var(--bg-elevated));
  box-shadow: var(--shadow-lg);
}

header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  padding: 20px 20px 14px;
}

h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 650;
}
p {
  margin: 5px 0 0;
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
}
header button:hover {
  color: rgb(var(--fg));
  background: rgb(var(--bg-inset));
}

.command-search {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 0 16px 12px;
  padding: 9px 12px;
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
  padding: 0 10px 12px;
}
.command-center-item {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 11px 12px;
  border: 0;
  border-radius: var(--radius);
  text-align: left;
  color: rgb(var(--fg));
  background: transparent;
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
  gap: 3px;
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
.command-disabled-reason {
  color: rgb(var(--warn)) !important;
}
.command-center-meta {
  flex: none;
  color: rgb(var(--fg-muted));
  font-size: var(--font-size-2xs);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.command-center-empty {
  padding: 30px 12px;
  text-align: center;
}

@media (prefers-reduced-motion: no-preference) {
  .command-center-dialog {
    animation: command-center-in 160ms ease-out;
  }
}
@keyframes command-center-in {
  from {
    opacity: 0;
    transform: translateY(-8px) scale(0.99);
  }
}
</style>
