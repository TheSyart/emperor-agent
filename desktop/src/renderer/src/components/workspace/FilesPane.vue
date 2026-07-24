<script setup lang="ts">
import type { WorkspaceFileEntry, WorkspaceFileReadResult } from '@emperor/core'
import {
  ChevronDown,
  ChevronRight,
  Copy,
  File,
  Folder,
  FolderOpen,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Search,
  X,
} from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { core } from '../../api/http'
import { useMarkdown } from '../../composables/useMarkdown'

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
const showHidden = ref(false)
const showIgnored = ref(false)
const treeVisible = ref(true)
let requestGeneration = 0
let dragStartX = 0
let dragStartWidth = 280

const activeTab = computed(
  () => tabs.value.find((tab) => tab.path === activePath.value) || null,
)
const markdownSource = computed(() => activeTab.value?.preview.content || '')
const { rendered: renderedMarkdown } = useMarkdown(markdownSource)
const isMarkdown = computed(() =>
  /(?:^|\.)md(?:own)?$/i.test(activeTab.value?.preview.name || ''),
)
const codeLines = computed(() =>
  (activeTab.value?.preview.content || '').split('\n'),
)
const treeRows = computed<TreeRow[]>(() => {
  if (searchResults.value)
    return searchResults.value.map((entry) => ({ entry, level: 0 }))
  const rows: TreeRow[] = []
  appendDirectoryRows('', 0, rows)
  return rows
})
const panelStyle = computed(() => ({ width: `${props.treeWidth}px` }))

onMounted(() => void loadDirectory(''))
onBeforeUnmount(stopTreeResize)
watch(
  () => props.sessionId,
  () => void resetSession(),
)
watch(showHidden, () => void reloadTree())
watch(showIgnored, () => void reloadTree())

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
      showHidden: showHidden.value,
      showIgnored: showIgnored.value,
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
      showHidden: showHidden.value,
      showIgnored: showIgnored.value,
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

function startTreeResize(event: MouseEvent): void {
  dragStartX = event.clientX
  dragStartWidth = props.treeWidth
  document.body.classList.add('workspace-resizing')
  window.addEventListener('mousemove', resizeTree)
  window.addEventListener('mouseup', finishTreeResize, { once: true })
}

function resizeTree(event: MouseEvent): void {
  emit(
    'treeWidth',
    Math.max(240, Math.min(320, dragStartWidth + dragStartX - event.clientX)),
  )
}

function finishTreeResize(): void {
  stopTreeResize()
}

function stopTreeResize(): void {
  document.body.classList.remove('workspace-resizing')
  window.removeEventListener('mousemove', resizeTree)
  window.removeEventListener('mouseup', finishTreeResize)
}

function isCurrent(owner: string, generation: number): boolean {
  return props.sessionId === owner && requestGeneration === generation
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
</script>

<template>
  <div class="workspace-pane files-pane-wide">
    <header class="file-tabs-bar">
      <div class="file-tabs" role="tablist" aria-label="已打开文件">
        <div
          v-for="tab in tabs"
          :key="tab.path"
          class="file-tab"
          :class="{ active: tab.path === activePath }"
        >
          <button type="button" role="tab" @click="activePath = tab.path">
            <File :size="13" />
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
        class="workspace-icon-button file-tree-toggle"
        :aria-label="treeVisible ? '隐藏文件树' : '显示文件树'"
        @click="treeVisible = !treeVisible"
      >
        <PanelRightClose v-if="treeVisible" :size="15" />
        <PanelRightOpen v-else :size="15" />
      </button>
    </header>

    <div class="files-workbench-body">
      <main class="file-preview-stage">
        <template v-if="activeTab">
          <header class="file-preview-toolbar">
            <div class="file-preview-breadcrumb">{{ activeTab.path }}</div>
            <div>
              <button v-if="isMarkdown" type="button" @click="toggleSourceMode">
                {{ activeTab.sourceMode ? 'Preview' : 'View source' }}
              </button>
              <button
                type="button"
                title="复制相对路径"
                @click="copyPath(true)"
              >
                <Copy :size="13" />
              </button>
              <button
                type="button"
                title="复制绝对路径"
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
            ></div>
            <div
              v-else-if="activeTab.preview.kind === 'text'"
              class="file-code-view"
            >
              <div
                v-for="(line, index) in codeLines"
                :key="index"
                class="file-code-line"
              >
                <span>{{ index + 1 }}</span
                ><code>{{ line || ' ' }}</code>
              </div>
            </div>
            <div v-else class="workspace-empty-state">
              二进制文件仅提供元数据，不在应用内预览。
            </div>
            <small v-if="activeTab.preview.truncated">
              预览已截断 · {{ activeTab.preview.bytes }} bytes
            </small>
          </article>
        </template>
        <div v-else class="workspace-empty-state files-empty-preview">
          从右侧文件树选择一个文件
        </div>
      </main>

      <aside v-if="treeVisible" class="file-tree-panel" :style="panelStyle">
        <button
          type="button"
          class="file-tree-resizer"
          aria-label="调整文件树宽度"
          @mousedown="startTreeResize"
        ></button>
        <form class="workspace-search" @submit.prevent="searchFiles">
          <Search :size="14" />
          <input
            v-model="query"
            placeholder="Filter files…"
            aria-label="搜索项目文件"
            @input="!query.trim() && (searchResults = null)"
          />
        </form>
        <div class="file-tree-options">
          <label><input v-model="showHidden" type="checkbox" /> 隐藏文件</label>
          <label><input v-model="showIgnored" type="checkbox" /> ignored</label>
          <button type="button" aria-label="刷新文件树" @click="reloadTree">
            <RefreshCw :size="13" :class="{ 'animate-spin': loading }" />
          </button>
        </div>
        <div v-if="error" class="workspace-inline-error">{{ error }}</div>
        <div v-if="resultsTruncated" class="workspace-inline-warning">
          当前列表已达到安全扫描上限。
        </div>
        <div class="file-tree-list" role="tree">
          <button
            v-for="row in treeRows"
            :key="row.entry.path"
            type="button"
            class="file-tree-row"
            :class="{ active: row.entry.path === activePath }"
            :style="{ paddingLeft: `${8 + row.level * 14}px` }"
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
            <File v-else :size="14" />
            <span>{{ row.entry.name }}</span>
          </button>
          <div v-if="!treeRows.length && !loading" class="workspace-muted">
            没有匹配文件
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>
