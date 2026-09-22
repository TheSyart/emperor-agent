<script setup lang="ts">
import type {
  WorkspaceFileEntry,
  WorkspaceFileReadResult,
} from '@emperor/core/api'
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Folder,
  FolderOpen,
  PanelTopClose,
  PanelTopOpen,
  RefreshCw,
  Search,
  X,
} from 'lucide-vue-next'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useResizable } from '../../composables/useResizable'
import { core } from '../../api/http'
import { useMarkdown } from '../../composables/useMarkdown'
import { handleMarkdownChipClick } from '../../composables/useMarkdownLinks'
import { fileIconFor } from './fileIcon'
import { highlightFile } from './fileHighlight'

interface FileTab {
  path: string
  preview: WorkspaceFileReadResult
  sourceMode: boolean
}

interface TreeRow {
  entry: WorkspaceFileEntry
  level: number
}

const props = defineProps<{
  sessionId: string
  projectPath: string
  /** Tree section size in px (persisted as right_workspace.filesTreeWidth).
   *  The details column is too narrow for a side-by-side split, so the tree
   *  stacks above the preview and this is its height once a file is open. */
  treeWidth: number
}>()
const emit = defineEmits<{ treeWidth: [width: number] }>()

const treeByDirectory = ref<Record<string, WorkspaceFileEntry[]>>({})
const expanded = ref(new Set<string>())
const searchResults = ref<WorkspaceFileEntry[] | null>(null)
const tabs = ref<FileTab[]>([])
const activePath = ref('')
const projectRoot = ref('')
const query = ref('')
const loading = ref(false)
const error = ref('')
const resultsTruncated = ref(false)
const treeVisible = ref(true)
const activeLine = ref<number | null>(null)
let requestGeneration = 0

const activeTab = computed(
  () => tabs.value.find((tab) => tab.path === activePath.value) || null,
)

// Bridge the parent-owned tree size into a ref the resizable primitive drives;
// writes emit back up so the parent stays the source of truth. The separator
// sits on the tree's bottom edge (tree above, preview below).
const treeWidthRef = computed({
  get: () => props.treeWidth,
  set: (width) => emit('treeWidth', Math.max(240, Math.min(320, width))),
})
const { separatorProps: treeResizerProps } = useResizable({
  size: treeWidthRef,
  min: 240,
  max: 320,
  edge: 'bottom',
  snap: [240, 280, 320],
  snapThreshold: 20,
})

const markdownSource = computed(() => activeTab.value?.preview.content || '')
const { rendered: renderedMarkdown } = useMarkdown(markdownSource)
const isMarkdown = computed(() =>
  /(?:^|\.)md(?:own)?$/i.test(activeTab.value?.preview.name || ''),
)
const codeView = computed(() =>
  highlightFile(
    activeTab.value?.preview.name || '',
    activeTab.value?.preview.content || '',
  ),
)
const treeRows = computed<TreeRow[]>(() => {
  if (searchResults.value)
    return searchResults.value.map((entry) => ({ entry, level: 0 }))
  const rows: TreeRow[] = []
  appendDirectoryRows('', 0, rows)
  return rows
})
const panelStyle = computed(() =>
  activeTab.value ? { height: `${props.treeWidth}px` } : undefined,
)

onMounted(() => void loadDirectory(''))
watch(
  () => props.sessionId,
  () => void resetSession(),
)

function appendDirectoryRows(path: string, level: number, rows: TreeRow[]) {
  for (const entry of treeByDirectory.value[path] || []) {
    rows.push({ entry, level })
    if (isDirectory(entry) && expanded.value.has(entry.path))
      appendDirectoryRows(entry.path, level + 1, rows)
  }
}

function isDirectory(entry: WorkspaceFileEntry) {
  return (
    entry.kind === 'directory' ||
    (entry.kind === 'symlink' && entry.targetKind === 'directory')
  )
}

async function resetSession(): Promise<void> {
  requestGeneration += 1
  treeByDirectory.value = {}
  expanded.value = new Set()
  searchResults.value = null
  tabs.value = []
  activePath.value = ''
  query.value = ''
  error.value = ''
  await loadDirectory('')
}

async function reloadTree(): Promise<void> {
  treeByDirectory.value = {}
  expanded.value = new Set()
  searchResults.value = null
  await loadDirectory('')
}

async function loadDirectory(path: string): Promise<void> {
  const owner = props.sessionId
  const generation = ++requestGeneration
  loading.value = true
  error.value = ''
  try {
    const result = await core('files.list', {
      sessionId: owner,
      relativePath: path,
      limit: 500,
    })
    if (!isCurrent(owner, generation)) return
    projectRoot.value = result.projectRoot
    treeByDirectory.value = {
      ...treeByDirectory.value,
      [result.relativePath]: result.entries,
    }
    resultsTruncated.value = Boolean(result.truncated || result.nextCursor)
  } catch (cause) {
    if (isCurrent(owner, generation)) error.value = message(cause)
  } finally {
    if (isCurrent(owner, generation)) loading.value = false
  }
}

async function toggleDirectory(entry: WorkspaceFileEntry): Promise<void> {
  const next = new Set(expanded.value)
  if (next.has(entry.path)) {
    next.delete(entry.path)
    expanded.value = next
    return
  }
  next.add(entry.path)
  expanded.value = next
  if (!treeByDirectory.value[entry.path]) await loadDirectory(entry.path)
}

async function searchFiles(): Promise<void> {
  const searchTerm = query.value.trim()
  if (!searchTerm) {
    searchResults.value = null
    return
  }
  const owner = props.sessionId
  const generation = ++requestGeneration
  loading.value = true
  error.value = ''
  try {
    const result = await core('files.search', {
      sessionId: owner,
      query: searchTerm,
      limit: 500,
    })
    if (!isCurrent(owner, generation)) return
    projectRoot.value = result.projectRoot
    searchResults.value = result.entries
    resultsTruncated.value = Boolean(result.truncated || result.nextCursor)
  } catch (cause) {
    if (isCurrent(owner, generation)) error.value = message(cause)
  } finally {
    if (isCurrent(owner, generation)) loading.value = false
  }
}

async function openEntry(entry: WorkspaceFileEntry): Promise<void> {
  if (isDirectory(entry)) return toggleDirectory(entry)
  const existing = tabs.value.find((tab) => tab.path === entry.path)
  if (existing) {
    activePath.value = existing.path
    return
  }
  const owner = props.sessionId
  const generation = ++requestGeneration
  loading.value = true
  error.value = ''
  try {
    const preview = await core('files.read', {
      sessionId: owner,
      relativePath: entry.path,
    })
    if (!isCurrent(owner, generation)) return
    tabs.value = [
      ...tabs.value,
      { path: entry.path, preview, sourceMode: false },
    ]
    activePath.value = entry.path
  } catch (cause) {
    if (isCurrent(owner, generation)) error.value = message(cause)
  } finally {
    if (isCurrent(owner, generation)) loading.value = false
  }
}

async function openPath(relativePath: string, line?: number): Promise<void> {
  const path = relativePath.replaceAll('\\', '/').replace(/^\.\/+/, '')
  if (!path) return
  activeLine.value = normalizeLine(line)
  const existing = tabs.value.find((tab) => tab.path === path)
  if (existing) {
    activePath.value = path
    await revealActiveLine()
    return
  }
  const owner = props.sessionId
  const generation = ++requestGeneration
  loading.value = true
  error.value = ''
  try {
    const preview = await core('files.read', {
      sessionId: owner,
      relativePath: path,
    })
    if (!isCurrent(owner, generation)) return
    tabs.value = [...tabs.value, { path, preview, sourceMode: false }]
    activePath.value = path
    await expandAncestors(path)
    await revealActiveLine()
  } catch (cause) {
    if (isCurrent(owner, generation)) error.value = message(cause)
  } finally {
    if (isCurrent(owner, generation)) loading.value = false
  }
}

async function expandAncestors(path: string): Promise<void> {
  const parts = path.split('/').slice(0, -1)
  let current = ''
  for (const part of parts) {
    current = current ? `${current}/${part}` : part
    expanded.value = new Set([...expanded.value, current])
    if (!treeByDirectory.value[current]) await loadDirectory(current)
  }
}

function normalizeLine(value?: number): number | null {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null
}

async function revealActiveLine(): Promise<void> {
  await nextTick()
  if (!activeLine.value) return
  document
    .querySelector<HTMLElement>(
      `.file-code-line[data-line="${activeLine.value}"]`,
    )
    ?.scrollIntoView({ block: 'center' })
}

function handleMarkdownClick(event: MouseEvent): void {
  handleMarkdownChipClick(
    event,
    `file-preview:${activeTab.value?.path || 'unknown'}`,
  )
}

defineExpose({ openPath })

function closeTab(path: string): void {
  const index = tabs.value.findIndex((tab) => tab.path === path)
  if (index < 0) return
  tabs.value = tabs.value.filter((tab) => tab.path !== path)
  if (activePath.value !== path) return
  activePath.value = tabs.value[Math.max(0, index - 1)]?.path || ''
}

function toggleSourceMode(): void {
  const tab = activeTab.value
  if (tab) tab.sourceMode = !tab.sourceMode
}

async function copyPath(relative: boolean): Promise<void> {
  const path = activeTab.value?.path
  if (!path) return
  const base = projectRoot.value.replace(/\/$/, '')
  const separator = base.includes('\\') ? '\\' : '/'
  await navigator.clipboard.writeText(
    relative ? path : `${base}${separator}${path}`,
  )
}

function isCurrent(owner: string, generation: number): boolean {
  return props.sessionId === owner && requestGeneration === generation
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
</script>

<template>
  <div class="files-pane">
    <header class="file-tabs-bar">
      <div class="file-tabs" role="tablist" aria-label="已打开文件">
        <div
          v-for="tab in tabs"
          :key="tab.path"
          class="file-tab"
          :class="{ active: tab.path === activePath }"
        >
          <button
            type="button"
            role="tab"
            class="file-tab-main"
            :aria-selected="tab.path === activePath"
            @click="activePath = tab.path"
          >
            <component
              :is="fileIconFor(tab.preview.name, false).icon"
              :size="13"
              :class="`file-icon-tone-${fileIconFor(tab.preview.name, false).tone}`"
            />
            <span>{{ tab.preview.name }}</span>
          </button>
          <button
            type="button"
            class="file-tab-close"
            :aria-label="`关闭 ${tab.preview.name}`"
            @click="closeTab(tab.path)"
          >
            <X :size="12" />
          </button>
        </div>
      </div>
      <button
        type="button"
        class="files-icon-button"
        :aria-label="treeVisible ? '隐藏文件树' : '显示文件树'"
        @click="treeVisible = !treeVisible"
      >
        <PanelTopClose v-if="treeVisible" :size="15" />
        <PanelTopOpen v-else :size="15" />
      </button>
    </header>

    <div class="files-body">
      <aside
        v-if="treeVisible"
        class="file-tree-panel"
        :class="{ 'file-tree-fill': !activeTab }"
        :style="panelStyle"
      >
        <div class="file-tree-toolbar">
          <form class="files-search" @submit.prevent="searchFiles">
            <Search :size="14" />
            <input
              v-model="query"
              placeholder="Filter files…"
              aria-label="搜索项目文件"
              @input="!query.trim() && (searchResults = null)"
            />
          </form>
          <button
            type="button"
            class="files-icon-button"
            aria-label="刷新文件树"
            @click="reloadTree"
          >
            <RefreshCw :size="13" :class="{ 'animate-spin': loading }" />
          </button>
        </div>
        <div v-if="error" class="files-inline-error">{{ error }}</div>
        <div v-if="resultsTruncated" class="files-inline-warning">
          当前列表已达到安全扫描上限。
        </div>
        <div class="file-tree-list" role="tree">
          <button
            v-for="row in treeRows"
            :key="row.entry.path"
            type="button"
            class="file-tree-row"
            :class="{ active: row.entry.path === activePath }"
            :style="{
              paddingLeft: `calc(var(--space-2) + ${row.level} * var(--space-3-5))`,
            }"
            role="treeitem"
            @click="openEntry(row.entry)"
          >
            <ChevronDown
              v-if="isDirectory(row.entry) && expanded.has(row.entry.path)"
              :size="13"
            />
            <ChevronRight v-else-if="isDirectory(row.entry)" :size="13" />
            <span v-else class="file-tree-spacer"></span>
            <FolderOpen
              v-if="isDirectory(row.entry) && expanded.has(row.entry.path)"
              :size="14"
            />
            <Folder v-else-if="isDirectory(row.entry)" :size="14" />
            <component
              :is="fileIconFor(row.entry.name, false).icon"
              v-else
              :size="14"
              :class="`file-icon-tone-${fileIconFor(row.entry.name, false).tone}`"
            />
            <span>{{ row.entry.name }}</span>
          </button>
          <div v-if="!treeRows.length && !loading" class="files-muted">
            没有匹配文件
          </div>
        </div>
        <button
          v-if="activeTab"
          type="button"
          class="file-tree-resizer"
          aria-label="调整文件树高度"
          v-bind="treeResizerProps"
        ></button>
      </aside>

      <main v-if="activeTab || !treeVisible" class="file-preview-stage">
        <template v-if="activeTab">
          <header class="file-preview-toolbar">
            <div class="file-preview-breadcrumb" :title="activeTab.path">
              {{ activeTab.path }}
            </div>
            <div class="file-preview-actions">
              <button v-if="isMarkdown" type="button" @click="toggleSourceMode">
                {{ activeTab.sourceMode ? 'Preview' : 'View source' }}
              </button>
              <button
                type="button"
                title="复制相对路径"
                aria-label="复制相对路径"
                @click="copyPath(true)"
              >
                <Copy :size="13" />
              </button>
              <button
                type="button"
                title="复制绝对路径"
                aria-label="复制绝对路径"
                @click="copyPath(false)"
              >
                <Copy :size="13" /> /
              </button>
            </div>
          </header>
          <article class="file-preview-content">
            <img
              v-if="
                activeTab.preview.kind === 'image' &&
                activeTab.preview.dataBase64
              "
              :src="`data:${activeTab.preview.mimeType};base64,${activeTab.preview.dataBase64}`"
              :alt="activeTab.preview.name"
            />
            <div
              v-else-if="isMarkdown && !activeTab.sourceMode"
              class="markdown-body file-markdown-preview"
              v-html="renderedMarkdown"
              @click="handleMarkdownClick"
            ></div>
            <div
              v-else-if="activeTab.preview.kind === 'text'"
              class="file-code-view"
            >
              <div
                v-for="(line, index) in codeView.lines"
                :key="index"
                class="file-code-line"
                :class="{ 'reference-line-active': activeLine === index + 1 }"
                :data-line="index + 1"
              >
                <span>{{ index + 1 }}</span
                ><code v-html="line || ' '"></code>
              </div>
            </div>
            <div v-else class="files-muted">
              二进制文件仅提供元数据，不在应用内预览。
            </div>
            <small v-if="activeTab.preview.truncated" class="file-truncated">
              预览已截断 · {{ activeTab.preview.bytes }} bytes
            </small>
          </article>
        </template>
        <div v-else class="files-muted files-empty-preview">
          显示文件树并选择一个文件
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
.files-pane {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
}

.file-tabs-bar {
  display: flex;
  min-height: calc(var(--space-8) + var(--space-1));
  flex: none;
  align-items: center;
  gap: var(--space-1);
  padding: 0 var(--space-2) 0 0;
  border-bottom: 1px solid var(--border-l1);
}

.file-tabs {
  display: flex;
  min-width: 0;
  flex: 1;
  align-self: stretch;
  align-items: stretch;
  overflow-x: auto;
  scrollbar-width: none;
}

.file-tabs::-webkit-scrollbar {
  display: none;
}

.file-tab {
  position: relative;
  display: inline-flex;
  max-width: 160px;
  flex: none;
  align-items: stretch;
  color: rgb(var(--label-tertiary));
}

.file-tab:hover {
  color: rgb(var(--label-secondary));
}

.file-tab.active {
  color: rgb(var(--label-primary));
}

.file-tab.active::after {
  content: '';
  position: absolute;
  right: var(--space-2);
  bottom: 0;
  left: var(--space-3);
  height: 2px;
  border-radius: 2px;
  background: rgb(var(--accent-fill));
}

.file-tab-main {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--space-1-5);
  padding: 0 var(--space-1) 0 var(--space-3);
  color: inherit;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.file-tab-main span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-tab-close {
  display: inline-grid;
  align-self: center;
  place-items: center;
  margin-right: var(--space-1);
  padding: 2px;
  border-radius: var(--radius-xs);
  color: rgb(var(--label-tertiary));
  opacity: 0;
}

.file-tab:hover .file-tab-close,
.file-tab.active .file-tab-close,
.file-tab-close:focus-visible {
  opacity: 1;
}

.file-tab-close:hover {
  color: rgb(var(--label-primary));
  background: var(--interactive-bg-hover);
}

.files-icon-button {
  display: inline-grid;
  width: var(--space-7);
  height: var(--space-7);
  flex: none;
  place-items: center;
  border-radius: var(--radius-row);
  color: rgb(var(--label-secondary));
}

.files-icon-button:hover {
  color: rgb(var(--label-primary));
  background: var(--interactive-bg-hover);
}

.files-body {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
}

.file-tree-panel {
  position: relative;
  display: flex;
  min-height: 0;
  flex: none;
  flex-direction: column;
  padding: var(--space-2) var(--space-2) 0;
  border-bottom: 1px solid var(--border-l1);
}

.file-tree-panel.file-tree-fill {
  flex: 1;
  border-bottom: 0;
}

.file-tree-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-bottom: var(--space-1-5);
}

.files-search {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: var(--space-2);
  height: var(--space-8);
  padding: 0 var(--space-2-5);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-row);
  color: rgb(var(--label-tertiary));
  background: rgb(var(--input-major));
}

.files-search:focus-within {
  border-color: var(--border-l4);
}

.files-search input {
  min-width: 0;
  flex: 1;
  height: 100%;
  padding: 0;
  border: 0;
  outline: none;
  color: rgb(var(--label-primary));
  background: transparent;
  box-shadow: none;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.file-tree-list {
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding-bottom: var(--space-2);
}

.file-tree-row {
  display: grid;
  width: 100%;
  min-height: var(--space-7);
  grid-template-columns: 13px 14px minmax(0, 1fr);
  align-items: center;
  gap: var(--space-1-5);
  padding-block: var(--space-1);
  padding-right: var(--space-2);
  border-radius: var(--radius-row);
  color: rgb(var(--label-secondary));
  text-align: left;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.file-tree-row:hover {
  color: rgb(var(--label-primary));
  background: var(--interactive-bg-hover);
}

.file-tree-row.active {
  color: rgb(var(--label-primary));
  background: var(--interactive-bg-active);
}

.file-tree-row > span:last-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-tree-spacer {
  width: 13px;
}

.file-tree-resizer {
  position: absolute;
  z-index: var(--z-raised);
  right: 0;
  bottom: calc(var(--space-1-5) / -2);
  left: 0;
  height: var(--space-1-5);
  cursor: row-resize;
}

.file-tree-resizer:hover,
.file-tree-resizer:focus-visible {
  outline: none;
  background: rgb(var(--accent-fill) / 0.35);
}

.file-preview-stage {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
}

.file-preview-toolbar {
  display: flex;
  min-height: var(--space-8);
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2) var(--space-1) var(--space-3);
  border-bottom: 1px solid var(--border-l1);
}

.file-preview-breadcrumb {
  min-width: 0;
  overflow: hidden;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-preview-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-0-5);
}

.file-preview-actions button {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-1-5);
  border-radius: var(--radius-row);
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.file-preview-actions button:hover {
  color: rgb(var(--label-primary));
  background: var(--interactive-bg-hover);
}

.file-preview-content {
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: var(--space-3);
}

.file-preview-content > img {
  display: block;
  max-width: 100%;
  max-height: 100%;
  margin: auto;
  object-fit: contain;
}

.file-markdown-preview {
  color: rgb(var(--label-primary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.file-code-view {
  min-width: max-content;
  font-family: var(--font-mono);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.file-code-line {
  display: grid;
  grid-template-columns: var(--space-8) minmax(0, 1fr);
}

.file-code-line > span {
  position: sticky;
  left: 0;
  padding-right: var(--space-2);
  color: rgb(var(--label-caption));
  text-align: right;
  user-select: none;
  background: rgb(var(--bg-base));
}

.file-code-line code {
  color: rgb(var(--label-primary));
  white-space: pre;
}

.file-code-line.reference-line-active {
  background: rgb(var(--accent-fill) / 0.12);
  box-shadow: inset 2px 0 0 rgb(var(--accent-fill));
}

.file-code-line.reference-line-active > span {
  background: transparent;
}

.file-truncated {
  display: block;
  margin-top: var(--space-2);
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.files-muted {
  padding: var(--space-2);
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.files-empty-preview {
  display: grid;
  height: 100%;
  place-items: center;
}

.files-inline-error,
.files-inline-warning {
  margin-bottom: var(--space-1-5);
  padding: var(--space-1-5) var(--space-2);
  border-radius: var(--radius-row);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.files-inline-error {
  color: rgb(var(--danger));
  background: rgb(var(--danger-soft));
}

.files-inline-warning {
  color: rgb(var(--label-secondary));
  background: rgb(var(--warn-soft));
}

/* File icons colored by extension (tree + tabs), theme tokens only. */
.file-icon-tone-accent {
  color: rgb(var(--accent));
}
.file-icon-tone-brand {
  color: rgb(var(--brand));
}
.file-icon-tone-warn {
  color: rgb(var(--warn));
}
.file-icon-tone-ok {
  color: rgb(var(--ok));
}
.file-icon-tone-cyan {
  color: rgb(var(--tone-cyan));
}
.file-icon-tone-violet {
  color: rgb(var(--tone-violet));
}
.file-icon-tone-blue {
  color: rgb(var(--tone-blue));
}
.file-icon-tone-muted {
  color: rgb(var(--label-secondary));
}
.file-icon-tone-subtle {
  color: rgb(var(--label-tertiary));
}
</style>
