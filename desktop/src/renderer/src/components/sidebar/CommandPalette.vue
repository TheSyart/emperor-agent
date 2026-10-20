<script setup lang="ts">
/**
 * Command palette (UI-S02): the rail's 搜索 and ⌘K open it centered over
 * the app. Titles match as you type (the sidebar's own sessions, archived
 * ones left out); after a short pause Core `sessions.search` adds the
 * sessions whose messages or replies say it, with a snippet. ↑ / ↓ move,
 * Enter opens, Esc closes. An empty query lists the latest sessions.
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { core } from '../../api/http'
import { useSession } from '../../composables/useSession'
import { sessionLocation } from '../../router'
import {
  searchSidebarSessions,
  sidebarRelativeTime,
} from '../../runtime/sidebarModel'
import { DsSearch } from '../icons/ds'
import Kbd from '../ui/Kbd.vue'
import { useModalLayer } from '../ui/modalStack'
import { provideSurface } from '../ui/surface'
import { useFocusTrap } from '../ui/useFocusTrap'

interface ContentHit {
  sessionId: string
  title: string
  role: 'user' | 'assistant'
  snippet: string
}

interface PaletteItem {
  id: string
  title: string
  meta: string
  group: 'recent' | 'titles' | 'contents'
}

const GROUP_LABELS: Record<PaletteItem['group'], string> = {
  recent: '最近',
  titles: '会话',
  contents: '内容',
}
const CONTENT_DELAY_MS = 250
const RECENT_COUNT = 8

const open = defineModel<boolean>('open', { default: false })
const router = useRouter()
const { sessions } = useSession()

const overlay = ref<HTMLElement | null>(null)
const dialog = ref<HTMLElement | null>(null)
const list = ref<HTMLElement | null>(null)
const query = ref('')
const contentHits = ref<ContentHit[]>([])
const contentQuery = ref('')
const searching = ref(false)
const selected = ref(0)
let timer: ReturnType<typeof setTimeout> | null = null
let generation = 0

const trimmed = computed(() => query.value.trim())

const items = computed<PaletteItem[]>(() => {
  if (!trimmed.value)
    return sessions.value
      .filter((session) => !session.archived_at && !session.draft)
      .slice(0, RECENT_COUNT)
      .map((session) => ({
        id: session.id,
        title: session.title || '新会话',
        meta: session.project_name || sidebarRelativeTime(session.updated_at),
        group: 'recent' as const,
      }))
  const titles = searchSidebarSessions(sessions.value, trimmed.value).map(
    (result) => ({
      id: result.id,
      title: result.title,
      meta: result.subtitle,
      group: 'titles' as const,
    }),
  )
  const seen = new Set(titles.map((item) => item.id))
  const contents =
    contentQuery.value === trimmed.value
      ? contentHits.value
          .filter((hit) => !seen.has(hit.sessionId))
          .map((hit) => ({
            id: hit.sessionId,
            title: hit.title || '新会话',
            meta: `${hit.role === 'user' ? '你' : '助手'}：${hit.snippet}`,
            group: 'contents' as const,
          }))
      : []
  return [...titles, ...contents]
})

const sections = computed(() => {
  const out: { group: PaletteItem['group']; items: [PaletteItem, number][] }[] =
    []
  items.value.forEach((item, index) => {
    const last = out.at(-1)
    if (last?.group === item.group) last.items.push([item, index])
    else out.push({ group: item.group, items: [[item, index]] })
  })
  return out
})

const emptyText = computed(() => {
  if (items.value.length) return ''
  if (!trimmed.value) return '还没有会话'
  return searching.value ? '正在搜索内容…' : '没有匹配的会话'
})

function clearTimer(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
}

async function searchContents(text: string, run: number): Promise<void> {
  try {
    const result = (await core('sessions.search', {
      query: text,
      limit: 20,
    })) as { hits?: ContentHit[] }
    if (run !== generation) return
    contentHits.value = result.hits ?? []
    contentQuery.value = text
  } catch {
    if (run !== generation) return
    contentHits.value = []
    contentQuery.value = text
  } finally {
    if (run === generation) searching.value = false
  }
}

watch(trimmed, (text) => {
  selected.value = 0
  clearTimer()
  const run = ++generation
  searching.value = Boolean(text)
  if (!text) return
  timer = setTimeout(() => {
    timer = null
    void searchContents(text, run)
  }, CONTENT_DELAY_MS)
})

watch(open, (value) => {
  if (value) return
  clearTimer()
  generation += 1
  query.value = ''
  contentHits.value = []
  contentQuery.value = ''
  searching.value = false
})

watch(
  () => items.value.length,
  (count) => {
    if (selected.value >= count) selected.value = Math.max(0, count - 1)
  },
)

function move(delta: 1 | -1): void {
  const count = items.value.length
  if (!count) return
  selected.value = (selected.value + delta + count) % count
  void nextTick(() =>
    list.value
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest' }),
  )
}

function choose(index: number): void {
  const item = items.value[index]
  if (!item) return
  open.value = false
  void router.push(sessionLocation(item.id)).catch(() => undefined)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing) return
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    move(1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    move(-1)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    choose(selected.value)
  }
}

useModalLayer(open, () => {
  open.value = false
})
useFocusTrap(dialog, open, { layer: () => overlay.value })
provideSurface(() => 'panel')
</script>

<template>
  <Teleport to="body">
    <div v-if="open" ref="overlay" class="command-palette">
      <div class="mask" @click="open = false" />
      <div
        ref="dialog"
        class="palette ds-fade-in"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        data-testid="command-palette"
      >
        <label class="field">
          <DsSearch :size="16" class="field-icon" />
          <input
            v-model="query"
            data-autofocus
            type="text"
            placeholder="搜索会话标题和内容"
            aria-label="搜索会话"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-results"
            autocomplete="off"
            spellcheck="false"
            @keydown="onKeydown"
          />
        </label>
        <div
          id="command-palette-results"
          ref="list"
          class="results"
          role="listbox"
          aria-label="搜索结果"
        >
          <template v-for="section in sections" :key="section.group">
            <div class="group-label" role="presentation">
              {{ GROUP_LABELS[section.group] }}
            </div>
            <div
              v-for="[item, index] in section.items"
              :key="`${section.group}:${item.id}`"
              class="result"
              role="option"
              :data-palette-result="item.id"
              :aria-selected="index === selected"
              @mousemove="selected = index"
              @mousedown.prevent
              @click="choose(index)"
            >
              <span class="result-title">{{ item.title }}</span>
              <span class="result-meta">{{ item.meta }}</span>
            </div>
          </template>
          <div v-if="emptyText" class="empty">{{ emptyText }}</div>
        </div>
        <div class="hints" aria-hidden="true">
          <span><Kbd>↑↓</Kbd> 选择</span>
          <span><Kbd>↵</Kbd> 打开</span>
          <span><Kbd>esc</Kbd> 关闭</span>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.command-palette {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 14vh var(--space-6) var(--space-6);
}

.mask {
  position: absolute;
  inset: 0;
  background: var(--mask-1);
  backdrop-filter: blur(var(--mask-blur));
}

.palette {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(560px, 100%);
  max-height: min(480px, 100%);
  overflow: hidden;
  border: 1px solid var(--border-inverted);
  border-radius: var(--radius-modal);
  outline: none;
  background: rgb(var(--bg-layer-2));
  box-shadow: var(--shadow-lv3);
}

.field {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-2);
  height: 52px;
  padding: 0 var(--space-5);
  border-bottom: 1px solid var(--border-l1);
  color: rgb(var(--label-tertiary));
}

.field input {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: none;
  outline: none;
  background: transparent;
  color: rgb(var(--label-primary));
  font-size: var(--fs-base);
  line-height: var(--lh-base);
}

.field input:focus {
  box-shadow: none;
}

.field input::placeholder {
  color: rgb(var(--label-caption));
}

.field-icon {
  flex: none;
}

.results {
  flex: 1;
  min-height: 0;
  padding: var(--space-1-5) var(--space-2);
  overflow-y: auto;
}

.group-label {
  padding: var(--space-2) var(--space-3) var(--space-1);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-caption));
}

.result {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: 48px;
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-row);
  cursor: pointer;
}

.result[aria-selected='true'] {
  background: var(--interactive-bg-hover);
}

.result-title,
.result-meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.result-title {
  font-size: var(--fs-s);
  line-height: var(--space-5);
  color: rgb(var(--label-primary));
}

.result-meta {
  font-size: var(--fs-xxs);
  line-height: 17px;
  color: rgb(var(--label-tertiary));
}

.empty {
  padding: var(--space-6) var(--space-3);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-caption));
  text-align: center;
}

.hints {
  display: flex;
  flex: none;
  gap: var(--space-4);
  padding: var(--space-2) var(--space-5);
  border-top: 1px solid var(--border-l1);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-caption));
}
</style>
