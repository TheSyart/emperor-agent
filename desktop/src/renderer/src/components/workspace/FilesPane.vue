<script setup lang="ts">
/**
 * FilesPane — the right workspace's 文件 pane: an open-file tab strip with
 * 「+」 over a path breadcrumb and the preview, and the project tree as a
 * column on the far right with a 「筛选文件…」 filter (files.search).
 *
 * Tabs: every opened file is a tab; 「打开文件」 is the draft tab shown when
 * nothing is open or after 「+」 (which also focuses the filter). Picking a
 * file while the draft is active replaces the draft. ⌘W (Ctrl+W off macOS)
 * closes the active tab only while focus is inside this pane.
 *
 * Props:
 * - sessionId, projectPath.
 * - treeWidth: tree column width in px (240–320; the parent persists it as
 *   right_workspace.filesTreeWidth).
 * Emits: treeWidth(px) once a column resize settles.
 * Exposes: openPath(path, line?) — open (or activate) a file at a line.
 */
import type {
  WorkspaceFileEntry,
  WorkspaceFileReadResult,
} from '@emperor/core/api'
import {
  ChevronDown,
  ChevronRight,
  Clipboard,
  Copy,
  FileText,
  Folder,
  FolderOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Search,
  X,
} from 'lucide-vue-next'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { core } from '../../api/http'
import { useMarkdown } from '../../composables/useMarkdown'
import { handleMarkdownChipClick } from '../../composables/useMarkdownLinks'
import { useResizable } from '../../composables/useResizable'
import { detectShortcutPlatform } from '../../shortcuts'
import IconButton from '../ui/IconButton.vue'
import { highlightFile } from './fileHighlight'
import { fileIconFor } from './fileIcon'
import {
  FILES_TREE_MAX,
  FILES_TREE_MIN,
  clampFilesTreeWidth,
  filePathCrumbs,
} from './workspaceModel'

interface FileTab {
  path: string
  preview: WorkspaceFileReadResult
  sourceMode: boolean
}

interface TreeRow {
  entry: WorkspaceFileEntry
  level: number
  /** Parent directory, shown for flat filter results. */
  hint: string
}

const props = defineProps<{
  sessionId: string
  projectPath: string
  treeWidth: number
}>()
const emit = defineEmits<{ treeWidth: [width: number] }>()

const SEARCH_DEBOUNCE_MS = 180
const platform = detectShortcutPlatform()

const paneRoot = ref<HTMLElement | null>(null)
const tabStrip = ref<HTMLElement | null>(null)
const previewBody = ref<HTMLElement | null>(null)
const filterInput = ref<HTMLInputElement | null>(null)
const treeByDirectory = ref<Record<string, WorkspaceFileEntry[]>>({})
const expanded = ref(new Set<string>())
const searchResults = ref<WorkspaceFileEntry[] | null>(null)
const tabs = ref<FileTab[]>([])
/** '' = the 「打开文件」 draft tab. */
const activePath = ref('')
const draftOpen = ref(false)
const projectRoot = ref('')
const query = ref('')
const loading = ref(false)
const treeError = ref('')
const openError = ref('')
const resultsTruncated = ref(false)
const treeVisible = ref(true)
const activeLine = ref<number | null>(null)
const columnWidth = ref(clampFilesTreeWidth(props.treeWidth))
let requestGeneration = 0
let searchTimer: ReturnType<typeof setTimeout> | undefined

const activeTab = computed(
  () => tabs.value.find((tab) => tab.path === activePath.value) || null,
)
const showDraftTab = computed(() => !tabs.value.length || draftOpen.value)
const crumbs = computed(() => filePathCrumbs(activeTab.value?.path ?? ''))

watch(
  () => props.treeWidth,
  (width) => (columnWidth.value = clampFilesTreeWidth(width)),
)
const { separatorProps: treeResizerProps } = useResizable({
  size: columnWidth,
  min: FILES_TREE_MIN,
  max: FILES_TREE_MAX,
  edge: 'left',
  snap: [FILES_TREE_MIN, 280, FILES_TREE_MAX],
  snapThreshold: 20,
  onCommit: (width) => emit('treeWidth', clampFilesTreeWidth(width)),
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
    return searchResults.value.map((entry) => ({
      entry,
      level: 0,
      hint: entry.path.split('/').slice(0, -1).join('/'),
    }))
  const rows: TreeRow[] = []
  appendDirectoryRows('', 0, rows)
  return rows
})

onMounted(() => void loadDirectory(''))
onBeforeUnmount(() => clearTimeout(searchTimer))
watch(
  () => props.sessionId,
  () => void resetSession(),
)
// Keep the active tab scrolled into the (scrollbar-less) strip.
watch([activePath, showDraftTab, () => tabs.value.length], () =>
  nextTick(revealActiveTab),
)

function revealActiveTab(): void {
  const strip = tabStrip.value
  const tab = strip?.querySelector<HTMLElement>('.file-tab.active')
  if (!strip || !tab) return
  const bounds = strip.getBoundingClientRect()
  const rect = tab.getBoundingClientRect()
  if (rect.left < bounds.left) strip.scrollLeft -= bounds.left - rect.left
  else if (rect.right > bounds.right)
    strip.scrollLeft += rect.right - bounds.right
}

function appendDirectoryRows(path: string, level: number, rows: TreeRow[]) {
  for (const entry of treeByDirectory.value[path] || []) {
    rows.push({ entry, level, hint: '' })
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
  clearTimeout(searchTimer)
  treeByDirectory.value = {}
  expanded.value = new Set()
  searchResults.value = null
  tabs.value = []
  activePath.value = ''
  draftOpen.value = false
  query.value = ''
  treeError.value = ''
  openError.value = ''
  await loadDirectory('')
}

async function reloadTree(): Promise<void> {
  treeByDirectory.value = {}
  expanded.value = new Set()
  searchResults.value = null
  if (query.value.trim()) await searchFiles()
  else await loadDirectory('')
}

async function loadDirectory(path: string): Promise<void> {
  const owner = props.sessionId
  const generation = ++requestGeneration
  loading.value = true
  treeError.value = ''
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
    if (isCurrent(owner, generation)) treeError.value = message(cause)
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

function onQueryInput(): void {
  clearTimeout(searchTimer)
  if (!query.value.trim()) {
    searchResults.value = null
    return
  }
  searchTimer = setTimeout(() => void searchFiles(), SEARCH_DEBOUNCE_MS)
}

function clearQuery(): void {
  clearTimeout(searchTimer)
  query.value = ''
  searchResults.value = null
}

async function searchFiles(): Promise<void> {
  clearTimeout(searchTimer)
  const searchTerm = query.value.trim()
  if (!searchTerm) {
    searchResults.value = null
    return
  }
  const owner = props.sessionId
  const generation = ++requestGeneration
  loading.value = true
  treeError.value = ''
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
    if (isCurrent(owner, generation)) treeError.value = message(cause)
  } finally {
    if (isCurrent(owner, generation)) loading.value = false
  }
}

async function openEntry(entry: WorkspaceFileEntry): Promise<void> {
  if (!isDirectory(entry)) return openFile(entry.path, null)
  if (!searchResults.value) return toggleDirectory(entry)
  // A directory among filter results: back to the tree, opened there.
  clearQuery()
  await expandAncestors(`${entry.path}/`)
}

async function openPath(relativePath: string, line?: number): Promise<void> {
  const path = relativePath.replaceAll('\\', '/').replace(/^\.\/+/, '')
  if (!path) return
  await openFile(path, normalizeLine(line), true)
}

/** Open (or activate) `path`; a draft tab gives way to the file. */
async function openFile(
  path: string,
  line: number | null,
  reveal = false,
): Promise<void> {
  activeLine.value = line
  openError.value = ''
  const existing = tabs.value.find((tab) => tab.path === path)
  if (existing) {
    activePath.value = path
    draftOpen.value = false
    await revealActiveLine()
    return
  }
  const owner = props.sessionId
  const generation = ++requestGeneration
  loading.value = true
  try {
    const preview = await core('files.read', {
      sessionId: owner,
      relativePath: path,
    })
    if (!isCurrent(owner, generation)) return
    tabs.value = [...tabs.value, { path, preview, sourceMode: false }]
    activePath.value = path
    draftOpen.value = false
    if (reveal) await expandAncestors(path)
    await revealActiveLine()
  } catch (cause) {
    if (isCurrent(owner, generation)) openError.value = message(cause)
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
  previewBody.value
    ?.querySelector<HTMLElement>(
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

function activateTab(path: string): void {
  activePath.value = path
  activeLine.value = null
  openError.value = ''
}

function closeTab(path: string): void {
  const index = tabs.value.findIndex((tab) => tab.path === path)
  if (index < 0) return
  tabs.value = tabs.value.filter((tab) => tab.path !== path)
  if (activePath.value === path)
    activePath.value = tabs.value[Math.max(0, index - 1)]?.path || ''
  if (!tabs.value.length) draftOpen.value = false
  keepFocusInPane()
}

/** 「+」: show the draft tab and put the caret in the tree filter. */
function startOpenFile(): void {
  if (tabs.value.length) draftOpen.value = true
  activePath.value = ''
  openError.value = ''
  treeVisible.value = true
  void nextTick(() => {
    filterInput.value?.focus()
    filterInput.value?.select()
  })
}

function closeDraft(): void {
  draftOpen.value = false
  if (!activePath.value)
    activePath.value = tabs.value[tabs.value.length - 1]?.path || ''
  keepFocusInPane()
}

function closeActiveTab(): void {
  if (activePath.value) closeTab(activePath.value)
  else if (tabs.value.length) closeDraft()
}

/** ⌘W / Ctrl+W: handled here so it never reaches the window while in the pane. */
function onPaneKeydown(event: KeyboardEvent): void {
  if (event.altKey || event.shiftKey || event.isComposing) return
  const mod =
    platform === 'mac'
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey
  if (!mod) return
  if (event.key.toLowerCase() !== 'w' && event.code !== 'KeyW') return
  event.preventDefault()
  event.stopPropagation()
  if (!event.repeat) closeActiveTab()
}

/** A removed tab button drops focus to <body>; keep it in the pane. */
function keepFocusInPane(): void {
  void nextTick(() => {
    const root = paneRoot.value
    if (!root || root.contains(document.activeElement)) return
    const active = tabStrip.value?.querySelector<HTMLElement>(
      '.file-tab.active [role="tab"]',
    )
    ;(active ?? root).focus()
  })
}

function toggleSourceMode(): void {
  const tab = activeTab.value
  if (tab) tab.sourceMode = !tab.sourceMode
}

async function copyPath(relative: boolean): Promise<void> {
  const path = activeTab.value?.path
  if (!path) return
  const base = projectRoot.value.replace(/[\\/]$/, '')
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
  <div
    ref="paneRoot"
    class="files-pane"
    tabindex="-1"
    :data-tree="treeVisible ? 'shown' : 'hidden'"
    @keydown="onPaneKeydown"
  >
    <section class="files-main" aria-label="文件预览">
      <header class="file-tabs-bar">
        <div
          ref="tabStrip"
          class="file-tabs"
          role="tablist"
          aria-label="已打开文件"
        >
          <div
            v-for="tab in tabs"
            :key="tab.path"
            class="file-tab"
            :class="{ active: tab.path === activePath }"
            :title="tab.path"
          >
            <button
              type="button"
              role="tab"
              class="file-tab-main"
              :aria-selected="tab.path === activePath"
              @click="activateTab(tab.path)"
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
          <div
            v-if="showDraftTab"
            class="file-tab draft"
            :class="{ active: !activePath }"
          >
            <button
              type="button"
              role="tab"
              class="file-tab-main"
              :aria-selected="!activePath"
              @click="activateTab('')"
            >
              <span>打开文件</span>
            </button>
            <button
              v-if="tabs.length"
              type="button"
              class="file-tab-close"
              aria-label="关闭 打开文件"
              @click="closeDraft"
            >
              <X :size="12" />
            </button>
          </div>
        </div>
        <IconButton label="打开文件" @click="startOpenFile">
          <Plus :size="15" />
        </IconButton>
        <IconButton
          :label="treeVisible ? '隐藏目录树' : '显示目录树'"
          :aria-pressed="treeVisible"
          @click="treeVisible = !treeVisible"
        >
          <PanelRightClose v-if="treeVisible" :size="15" />
          <PanelRightOpen v-else :size="15" />
        </IconButton>
      </header>

      <div class="file-crumbs-bar">
        <nav
          class="file-crumbs"
          aria-label="文件路径"
          :title="activeTab?.path || undefined"
        >
          <span class="crumb-root">/</span>
          <template v-for="(crumb, index) in crumbs" :key="crumb.path">
            <span v-if="index" class="crumb-sep" aria-hidden="true">/</span>
            <span
              class="crumb"
              :aria-current="index === crumbs.length - 1 ? 'page' : undefined"
              >{{ crumb.name }}</span
            >
          </template>
        </nav>
        <div v-if="activeTab" class="file-preview-actions">
          <button
            v-if="isMarkdown"
            type="button"
            class="source-toggle"
            @click="toggleSourceMode"
          >
            {{ activeTab.sourceMode ? '预览' : '源码' }}
          </button>
          <IconButton label="复制相对路径" @click="copyPath(true)">
            <Copy :size="13" />
          </IconButton>
          <IconButton label="复制绝对路径" @click="copyPath(false)">
            <Clipboard :size="13" />
          </IconButton>
        </div>
      </div>

      <div
        ref="previewBody"
        class="file-preview-content"
        tabindex="0"
        :aria-label="activeTab ? `${activeTab.preview.name} 预览` : '文件预览'"
      >
        <div v-if="openError" class="files-inline-error" role="alert">
          {{ openError }}
        </div>
        <template v-if="activeTab">
          <img
            v-if="
              activeTab.preview.kind === 'image' && activeTab.preview.dataBase64
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
        </template>
        <div v-else class="files-empty">
          <FileText :size="22" class="files-empty-glyph" aria-hidden="true" />
          <strong>打开文件</strong>
          <p>从项目目录树中选择文件</p>
        </div>
      </div>
    </section>

    <aside
      v-if="treeVisible"
      class="file-tree-column"
      aria-label="目录树"
      :style="{ width: `${columnWidth}px` }"
    >
      <div
        class="file-tree-resizer"
        aria-label="调整目录树宽度"
        v-bind="treeResizerProps"
      ></div>
      <div class="file-tree-toolbar">
        <form class="files-search" role="search" @submit.prevent="searchFiles">
          <Search :size="14" aria-hidden="true" />
          <input
            ref="filterInput"
            v-model="query"
            placeholder="筛选文件…"
            aria-label="筛选文件"
            @input="onQueryInput"
            @keydown.esc.prevent="clearQuery"
          />
        </form>
        <IconButton label="刷新目录树" @click="reloadTree">
          <RefreshCw :size="13" :class="{ 'animate-spin': loading }" />
        </IconButton>
      </div>
      <div v-if="treeError" class="files-inline-error" role="alert">
        {{ treeError }}
      </div>
      <div v-if="resultsTruncated" class="files-inline-warning">
        当前列表已达到安全扫描上限。
      </div>
      <div class="file-tree-list" role="tree" aria-label="项目文件">
        <button
          v-for="row in treeRows"
          :key="row.entry.path"
          type="button"
          class="file-tree-row"
          :class="{ active: row.entry.path === activePath }"
          :style="{
            paddingLeft: `calc(var(--space-2) + ${row.level} * var(--space-3-5))`,
          }"
          :title="row.entry.path"
          role="treeitem"
          :aria-expanded="
            isDirectory(row.entry) ? expanded.has(row.entry.path) : undefined
          "
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
          <span class="file-tree-name">
            {{ row.entry.name }}
            <small v-if="row.hint" class="file-tree-hint">{{ row.hint }}</small>
          </span>
        </button>
        <div v-if="!treeRows.length && !loading" class="files-muted">
          {{ searchResults ? '没有匹配文件' : '目录为空' }}
        </div>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.files-pane {
  display: flex;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  outline: none;
}

.files-main {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
}

/* ── tab strip ─────────────────────────────────────────────────────── */
.file-tabs-bar {
  display: flex;
  min-height: calc(var(--space-8) + var(--space-2));
  flex: none;
  align-items: center;
  gap: var(--space-0-5);
  padding: 0 var(--space-1-5) 0 0;
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
  max-width: 180px;
  flex: none;
  align-items: stretch;
  border-right: 1px solid var(--border-l1);
  color: rgb(var(--label-tertiary));
}

.file-tab:hover {
  color: rgb(var(--label-secondary));
}

.file-tab.active {
  color: rgb(var(--label-primary));
  background: rgb(var(--bg-layer-1));
}

.file-tab.active::after {
  content: '';
  position: absolute;
  right: 0;
  bottom: -1px;
  left: 0;
  height: 2px;
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

.file-tab.draft .file-tab-main {
  padding-right: var(--space-3);
}

.file-tab.draft:has(.file-tab-close) .file-tab-main {
  padding-right: var(--space-1);
}

.file-tab-main span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-tab-main:focus-visible,
.file-tab-close:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.file-tab-close {
  display: inline-grid;
  align-self: center;
  place-items: center;
  margin-right: var(--space-1-5);
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

/* ── breadcrumb ────────────────────────────────────────────────────── */
.file-crumbs-bar {
  display: flex;
  min-height: var(--space-8);
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 0 var(--space-1-5) 0 var(--space-3);
  border-bottom: 1px solid var(--border-l1);
}

.file-crumbs {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--space-1);
  overflow: hidden;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  white-space: nowrap;
}

.crumb {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.crumb:last-child {
  flex: none;
  max-width: 100%;
  color: rgb(var(--label-secondary));
}

.crumb-root,
.crumb-sep {
  flex: none;
  color: rgb(var(--label-caption));
}

.file-preview-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-0-5);
}

.source-toggle {
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-row);
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.source-toggle:hover {
  color: rgb(var(--label-primary));
  background: var(--interactive-bg-hover);
}

/* ── preview ───────────────────────────────────────────────────────── */
.file-preview-content {
  position: relative;
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: var(--space-3);
  outline: none;
}

.file-preview-content:focus-visible {
  box-shadow: inset 0 0 0 2px rgb(var(--focus-ring) / 0.4);
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

.files-empty {
  display: flex;
  height: 100%;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  padding: var(--space-4);
  text-align: center;
}

.files-empty-glyph {
  margin-bottom: var(--space-1-5);
  color: rgb(var(--label-tertiary));
}

.files-empty strong {
  color: rgb(var(--label-primary));
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: 500;
}

.files-empty p {
  margin: 0;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

/* ── tree column (far right) ──────────────────────────────────────── */
.file-tree-column {
  position: relative;
  display: flex;
  min-height: 0;
  flex: none;
  flex-direction: column;
  border-left: 1px solid var(--border-l1);
  background: rgb(var(--bg-layer-1) / 0.5);
}

.file-tree-resizer {
  position: absolute;
  z-index: var(--z-raised);
  top: 0;
  bottom: 0;
  left: calc(var(--space-1-5) / -2);
  width: var(--space-1-5);
  cursor: col-resize;
  touch-action: none;
}

.file-tree-resizer:hover,
.file-tree-resizer:focus-visible {
  outline: none;
  background: rgb(var(--accent-fill) / 0.35);
}

.file-tree-toolbar {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-1-5) var(--space-1-5) var(--space-2);
}

.files-search {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: var(--space-1-5);
  height: var(--space-7);
  padding: 0 var(--space-2);
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

.files-search input::placeholder {
  color: rgb(var(--label-tertiary));
}

.file-tree-list {
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: 0 var(--space-1-5) var(--space-2);
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

.file-tree-row:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.file-tree-name {
  display: flex;
  min-width: 0;
  flex-direction: column;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-tree-hint {
  overflow: hidden;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
  text-overflow: ellipsis;
}

.file-tree-spacer {
  width: 13px;
}

.files-muted {
  padding: var(--space-2);
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.files-inline-error,
.files-inline-warning {
  margin: 0 var(--space-2) var(--space-1-5);
  padding: var(--space-1-5) var(--space-2);
  border-radius: var(--radius-row);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.file-preview-content > .files-inline-error {
  margin: 0 0 var(--space-2);
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
