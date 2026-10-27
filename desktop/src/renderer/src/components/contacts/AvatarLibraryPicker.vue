<script setup lang="ts">
/**
 * AvatarLibraryPicker — 「从头像库选…」 (GRP-04, BRD-07, D21): the 135
 * Q-version portraits in a dialog, filtered by theme (全部 and the twelve
 * themes) and searched by name or theme. An avatar another contact uses is
 * marked 「在用」 and can still be picked. The labels and themes (the
 * manifest) load the first time the picker opens, never with the app.
 *
 * Props: open (v-model:open); selected? (the avatar shown now); inUse
 * (avatar id → the contact using it).
 * Emits: select(id) — and the picker closes; loaded(entries) once the
 * manifest is in.
 */
import { computed, ref, watch } from 'vue'
import Avatar from '../ui/Avatar.vue'
import Badge from '../ui/Badge.vue'
import EmptyState from '../ui/EmptyState.vue'
import Modal from '../ui/Modal.vue'
import SearchField from '../ui/SearchField.vue'
import Surface from '../ui/Surface.vue'
import Tag from '../ui/Tag.vue'
import {
  CONTACT_AVATAR_THEMES,
  CONTACT_AVATAR_THEME_LABELS,
  loadContactAvatarManifest,
  type ContactAvatarEntry,
  type ContactAvatarTheme,
} from '../ui/contactAvatars'

const props = withDefaults(
  defineProps<{
    selected?: string | null
    inUse?: Readonly<Record<string, string>>
  }>(),
  { selected: null, inUse: () => ({}) },
)
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{
  select: [id: string]
  /** The labels and themes, once loaded (the row shows the picked one's name). */
  loaded: [entries: ContactAvatarEntry[]]
}>()

const entries = ref<ContactAvatarEntry[]>([])
const failed = ref(false)
const theme = ref<ContactAvatarTheme | 'all'>('all')
const query = ref('')
let loading: Promise<void> | null = null

function load(): Promise<void> {
  loading ??= loadContactAvatarManifest().then(
    (list) => {
      entries.value = list
      emit('loaded', list)
    },
    () => {
      failed.value = true
      loading = null
    },
  )
  return loading
}

watch(
  open,
  (value) => {
    if (!value) return
    void load()
    theme.value = 'all'
    query.value = ''
  },
  { immediate: true },
)

const themes = computed(() => [
  { value: 'all' as const, label: '全部' },
  ...CONTACT_AVATAR_THEMES.map((value) => ({
    value,
    label: CONTACT_AVATAR_THEME_LABELS[value],
  })),
])

/** A search looks through every theme. */
watch(query, (value) => {
  if (value.trim()) theme.value = 'all'
})

const visible = computed(() => {
  const needle = query.value.trim().toLowerCase()
  return entries.value.filter((entry) => {
    if (theme.value !== 'all' && entry.theme !== theme.value) return false
    if (!needle) return true
    return [entry.label, CONTACT_AVATAR_THEME_LABELS[entry.theme], entry.id]
      .join(' ')
      .toLowerCase()
      .includes(needle)
  })
})

function cellTitle(entry: ContactAvatarEntry): string {
  const user = props.inUse[entry.id]
  return user ? `${entry.label}（「${user}」在用）` : entry.label
}

function pick(id: string) {
  emit('select', id)
  open.value = false
}
</script>

<template>
  <Modal
    v-model:open="open"
    title="头像库"
    description="135 个头像，照小单的 Q 版画风；别人在用的也可以选"
    :width="680"
  >
    <div class="picker" data-avatar-library>
      <SearchField
        v-model="query"
        class="search"
        placeholder="搜索：工程、猫、将军…"
        aria-label="搜索头像"
        size="sm"
      />
      <div class="themes" role="group" aria-label="按主题筛选">
        <Tag
          v-for="item in themes"
          :key="item.value"
          :data-avatar-theme="item.value"
          :selected="theme === item.value"
          :label="item.label"
          @click="theme = item.value"
        />
      </div>
      <p v-if="failed" class="status" role="alert">
        头像库没有加载出来，关掉再打开试试。
      </p>
      <div
        v-else-if="visible.length"
        class="grid"
        role="listbox"
        aria-label="头像"
      >
        <Surface
          v-for="entry in visible"
          :key="entry.id"
          as="button"
          tone="sunken"
          pad="none"
          interactive
          class="cell"
          role="option"
          :data-avatar-cell="entry.id"
          :aria-selected="entry.id === selected ? 'true' : 'false'"
          :title="cellTitle(entry)"
          @click="pick(entry.id)"
        >
          <Avatar
            kind="library"
            :id="entry.id"
            :size="40"
            :label="entry.label"
          />
          <span class="name">{{ entry.label }}</span>
          <Badge v-if="inUse[entry.id]" class="used" label="在用" />
        </Surface>
      </div>
      <EmptyState
        v-else-if="entries.length"
        variant="inline"
        :title="`没有找到「${query.trim()}」相关的头像`"
        description="换个词，或者按主题找"
      />
      <p class="foot">
        <span>{{ visible.length }} 个</span>
        <span>「在用」：已经有联系人在用，仍然可以选</span>
      </p>
    </div>
  </Modal>
</template>

<style scoped>
.picker {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
}

.search {
  max-width: 280px;
}

.themes {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(76px, 1fr));
  gap: var(--space-2);
  max-height: min(52vh, 440px);
  padding: var(--space-0-5);
  overflow-y: auto;
}

.grid .cell {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-1);
  background-color: transparent;
}

/* Bare cells; the hover fill and the focus ring stay Surface's. */
.grid .cell:not(:focus-visible) {
  box-shadow: none;
}

.cell[aria-selected='true'] :deep(.ds-avatar) {
  box-shadow:
    0 0 0 2px rgb(var(--surface-overlay)),
    0 0 0 3.5px rgb(var(--accent));
}

.name {
  max-width: 100%;
  overflow: hidden;
  color: rgb(var(--text-2));
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.used {
  position: absolute;
  top: var(--space-0-5);
  right: var(--space-0-5);
}

.status {
  margin: 0;
  color: rgb(var(--text-3));
  font-size: var(--fs-xs);
}

.foot {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  margin: 0;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}
</style>
