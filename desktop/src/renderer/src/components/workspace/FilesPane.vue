<script setup lang="ts">
/**
 * FilesPane — the right workspace's 文件 pane: an open-file tab strip
 * (WorkspaceTabBar, shared with 终端) with 「+」 over a path breadcrumb and
 * the preview, and the project tree as a column on the far right with a
 * 「筛选文件…」 filter (files.search).
 *
 * Tabs: every opened file is a tab (the strip is empty while nothing is
 * open; UI-S06 dropped the 「打开文件」 draft tab). 「+」 shows the tree and
 * puts the caret in its filter. ⌘W (Ctrl+W off macOS) closes the active tab
 * only while focus is inside this pane. One 「复制路径」 menu copies the
 * relative or the absolute path.
 *
 * Reopening (FIX-05): a request for a file that already has a tab first
 * asks Core for its size and mtime (files.stat); when either changed — or
 * the stat fails — the tab is read again, so a link to line N shows the
 * current text. Turn snapshots and attachments never change and are reused.
 * WorkspacePanel keeps this pane alive across pane switches (KeepAlive); the
 * scroll positions are put back on reactivation.
 *
 * Props:
 * - sessionId, projectPath.
 * - treeWidth: tree column width in px (240–320; the parent persists it as
 *   right_workspace.filesTreeWidth).
 * Emits: treeWidth(px) once a column resize settles.
 * Exposes: openPath(path, line?) — open (or activate) a file at a line.
 */
import EmptyState from '../ui/EmptyState.vue'
import LinkButton from '../ui/LinkButton.vue'
import Button from '../ui/Button.vue'
import Menu from '../ui/Menu.vue'
import MenuItem from '../ui/MenuItem.vue'
import SearchField from '../ui/SearchField.vue'
import type { TabItem } from '../ui/blockTypes'
import type { WorkspaceFileEntry, FilePreviewResult } from '@emperor/core/api'
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  FolderOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
} from 'lucide-vue-next'
import {
  computed,
  h,
  inject,
  markRaw,
  nextTick,
  onActivated,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type Component,
} from 'vue'
import { useWorkspaceSnapshot } from './useWorkspaceSnapshot'
import { core } from '../../api/http'
import type { WorkspaceFileRequest } from './workspaceState'
import { revealReference } from '../../api/backend'
import { openImageViewer } from '../ui/imageViewer'
import { useMarkdown } from '../../composables/useMarkdown'
import {
  handleMarkdownClick as routeMarkdownClick,
  handleMarkdownKeydown,
} from '../../composables/useMarkdownLinks'
import { APP_CONTEXT_KEY } from '../../composables/useAppContext'
import { useResizable } from '../../composables/useResizable'
import { detectShortcutPlatform } from '../../shortcuts'
import IconButton from '../ui/IconButton.vue'
import { highlightFile } from './fileHighlight'
import DocumentIcon from '../ui/DocumentIcon.vue'
import WorkspaceTabBar from './WorkspaceTabBar.vue'
import {
  FILES_TREE_MAX,
  FILES_TREE_MIN,
  clampFilesTreeWidth,
  filePathCrumbs,
} from './workspaceModel'

interface FileTab {
  path: string
  key: string
  request: WorkspaceFileRequest
  preview: FilePreviewResult
  sourceMode: boolean
}

interface TreeRow {
  entry: WorkspaceFileEntry
  level: number
  /** Parent directory, shown for flat filter results. */
  hint: string
}

const { viewedSessionId } = useWorkspaceSnapshot({ active: false })
const props = defineProps<{
  sessionId: string
  projectPath: string
  treeWidth: number
}>()
const emit = defineEmits<{ treeWidth: [width: number] }>()

const SEARCH_DEBOUNCE_MS = 180
/** Open file tabs kept at once; the oldest one is dropped beyond this. */
const MAX_FILE_TABS = 12
const platform = detectShortcutPlatform()

const paneRoot = ref<HTMLElement | null>(null)
const tabBar = ref<HTMLElement | null>(null)
const copyAnchor = ref<HTMLElement | null>(null)
const copyMenu = ref(false)
const previewBody = ref<HTMLElement | null>(null)
const treeList = ref<HTMLElement | null>(null)
const filterInput = ref<InstanceType<typeof SearchField> | null>(null)
const treeByDirectory = ref<Record<string, WorkspaceFileEntry[]>>({})
const expanded = ref(new Set<string>())
const searchResults = ref<WorkspaceFileEntry[] | null>(null)
const tabs = ref<FileTab[]>([])
/** Key of the active tab ('' while nothing is open). */
const activePath = ref('')
const projectRoot = ref('')
const query = ref('')
const loading = ref(false)
const treeError = ref('')
const openError = ref('')
const currentRequest = ref<WorkspaceFileRequest | null>(null)
const resultsTruncated = ref(false)
const treeVisible = ref(true)
const activeLine = ref<number | null>(null)
const columnWidth = ref(clampFilesTreeWidth(props.treeWidth))
let requestGeneration = 0
let fileGeneration = 0
/**
 * Directory listings belong to the tree, not to the latest request: they
 * go stale only when the tree starts over (a new session, a reload), so
 * opening a file while the root still loads keeps the tree.
 */
let treeGeneration = 0
let searchTimer: ReturnType<typeof setTimeout> | undefined

const isDraftSession = computed(() => props.sessionId.startsWith('draft:'))
const hasProject = computed(() =>
  Boolean(props.projectPath && !isDraftSession.value),
)
const activeTab = computed(
  () => tabs.value.find((tab) => tab.key === activePath.value) || null,
)
/** A file's type glyph as a Tabs icon (one per name, kept). */
const glyphs = new Map<string, Component>()
function fileGlyph(name: string): Component {
  let glyph = glyphs.get(name)
  if (!glyph) {
    glyph = markRaw(() => h(DocumentIcon, { path: name, size: 13 }))
    glyphs.set(name, glyph)
  }
  return glyph
}
const tabItems = computed<TabItem[]>(() =>
  tabs.value.map((tab) => ({
    id: tab.key,
    label: tab.preview.name,
    title: tab.path,
    icon: fileGlyph(tab.preview.name),
    closable: true,
  })),
)
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

onMounted(() => {
  if (hasProject.value) void loadDirectory('')
})
onBeforeUnmount(() => {
  clearTimeout(searchTimer)
  requestGeneration += 1
  fileGeneration += 1
  treeGeneration += 1
})

// KeepAlive detaches the DOM while another pane shows, and a detached
// scroller forgets its offset (already gone when onDeactivated runs): keep
// the last offsets as they change and put them back on reactivation.
const scrollOffsets = new Map<HTMLElement, [top: number, left: number]>()
function rememberScroll(event: Event): void {
  const target = event.target
  if (target instanceof HTMLElement)
    scrollOffsets.set(target, [target.scrollTop, target.scrollLeft])
}
onActivated(() => {
  void nextTick(() => {
    for (const [element, [top, left]] of scrollOffsets) {
      if (!element.isConnected) {
        scrollOffsets.delete(element)
        continue
      }
      element.scrollTop = top
      element.scrollLeft = left
    }
  })
})
watch(
  () => props.sessionId,
  () => void resetSession(),
)
// Keep the active tab scrolled into the (scrollbar-less) strip.
watch([activePath, () => tabs.value.length], () => nextTick(revealActiveTab))

function revealActiveTab(): void {
  const strip = tabBar.value?.querySelector<HTMLElement>('.ds-tabs')
  const tab = strip?.querySelector<HTMLElement>('.tab-item[data-active]')
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
  fileGeneration += 1
  treeGeneration += 1
  clearTimeout(searchTimer)
  treeByDirectory.value = {}
  expanded.value = new Set()
  searchResults.value = null
  tabs.value = []
  activePath.value = ''
  query.value = ''
  treeError.value = ''
  openError.value = ''
  currentRequest.value = null
  if (hasProject.value) await loadDirectory('')
}

async function reloadTree(): Promise<void> {
  treeGeneration += 1
  treeByDirectory.value = {}
  expanded.value = new Set()
  searchResults.value = null
  if (query.value.trim()) await searchFiles()
  else await loadDirectory('')
}

async function loadDirectory(path: string): Promise<void> {
  const owner = props.sessionId
  const tree = treeGeneration
  const current = () => props.sessionId === owner && treeGeneration === tree
  loading.value = true
  treeError.value = ''
  try {
    const result = await core('files.list', {
      sessionId: owner,
      relativePath: path,
      limit: 500,
    })
    if (!current()) return
    projectRoot.value = result.projectRoot
    treeByDirectory.value = {
      ...treeByDirectory.value,
      [result.relativePath]: result.entries,
    }
    resultsTruncated.value = Boolean(result.truncated || result.nextCursor)
  } catch (cause) {
    if (current()) treeError.value = message(cause)
  } finally {
    if (current()) loading.value = false
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

/** Show a directory opened in the tree, scrolled to and focused. */
async function openDirectory(relativePath: string): Promise<void> {
  const path = relativePath
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '')
  if (query.value) clearQuery()
  if (path) await expandAncestors(`${path}/`)
  await nextTick()
  const row = [
    ...(treeList.value?.querySelectorAll<HTMLElement>('[data-path]') ?? []),
  ].find((element) => element.dataset.path === path)
  row?.scrollIntoView({ block: 'nearest' })
  row?.focus({ preventScroll: true })
}

async function openPath(relativePath: string, line?: number): Promise<void> {
  const path = relativePath.replaceAll('\\', '/').replace(/^\.\/+/, '')
  if (!path) return
  await openFile(path, normalizeLine(line), true)
}

/** Project tree entry; other sources arrive through openPreview. */
async function openFile(
  path: string,
  line: number | null,
  reveal = false,
): Promise<void> {
  await openPreview({
    owner: props.sessionId,
    target: { source: 'project', sessionId: props.sessionId, path },
    ...(line ? { line } : {}),
  })
  if (reveal && hasProject.value) await expandAncestors(path)
}

async function openPreview(
  request: WorkspaceFileRequest,
  refresh = false,
): Promise<void> {
  // Requests come from the active session or the child log on screen; Core
  // re-checks that the owner may read the target.
  if (
    !request.owner ||
    (request.owner !== props.sessionId &&
      request.owner !== viewedSessionId.value)
  )
    return
  currentRequest.value = request
  const key = JSON.stringify(request.target)
  const existing = tabs.value.find(
    (tab) => JSON.stringify(tab.request.target) === key,
  )
  activeLine.value = normalizeLine(request.line)
  openError.value = ''
  const owner = props.sessionId
  if (existing && !refresh) {
    const generation = ++fileGeneration
    const changed = await changedOnDisk(existing)
    if (owner !== props.sessionId || generation !== fileGeneration) return
    if (!changed) {
      activePath.value = existing.key
      await revealActiveLine()
      return
    }
  }
  const generation = ++fileGeneration
  loading.value = true
  try {
    const preview = await core('files.preview', { ...request.target })
    if (owner !== props.sessionId || generation !== fileGeneration) return
    const tab = tabs.value.find((tab) => tab.key === preview.id)
    const path =
      request.target.source === 'project' || request.target.source === 'turn'
        ? request.target.path
        : preview.path
    // Previews can hold megabytes of base64; keep them out of deep reactivity.
    const raw = markRaw(preview)
    if (tab) {
      tab.preview = raw
      tab.request = request
    } else {
      const next = [
        ...tabs.value,
        { key: preview.id, path, request, preview: raw, sourceMode: false },
      ]
      while (next.length > MAX_FILE_TABS) next.shift()
      tabs.value = next
    }
    activePath.value = preview.id
    await revealActiveLine()
  } catch (cause) {
    if (owner === props.sessionId && generation === fileGeneration)
      openError.value = message(cause)
  } finally {
    if (owner === props.sessionId && generation === fileGeneration)
      loading.value = false
  }
}

/**
 * Whether a tab's file changed since it was read: size or mtime differ, or
 * the stat failed (gone, moved: reading again shows why).
 */
async function changedOnDisk(tab: FileTab): Promise<boolean> {
  const target = tab.request.target
  if (target.source !== 'project' && target.source !== 'reference') return false
  if (tab.preview.kind === 'directory') return false
  try {
    const stat = await core('files.stat', { ...target })
    return (
      stat.bytes !== tab.preview.bytes ||
      stat.modifiedAt !== tab.preview.modifiedAt
    )
  } catch {
    return true
  }
}

function revealSource(nodeKey: string): void {
  window.dispatchEvent(
    new CustomEvent('emperor:file-source', {
      detail: { owner: props.sessionId, nodeKey },
    }),
  )
}

function refreshFile(): void {
  const request = currentRequest.value ?? activeTab.value?.request
  if (request) void openPreview(request, true)
}

async function revealFile(): Promise<void> {
  const target = activeTab.value?.request.target
  try {
    if (target?.source === 'reference')
      await revealReference({
        sessionId: target.sessionId,
        referenceId: target.referenceId,
      })
    else if (
      target?.source === 'attachment' &&
      !props.sessionId.startsWith('draft:')
    ) {
      const owner = props.sessionId
      const reference = await core('references.resolve', {
        sessionId: owner,
        sourceMessageId: `file-preview:${target.attachmentId}`,
        href: `attachment:${target.attachmentId}`,
        label: activeTab.value?.preview.name || '附件',
      })
      if (owner === props.sessionId)
        await revealReference({ sessionId: owner, referenceId: reference.id })
    }
  } catch (cause) {
    openError.value = message(cause)
  }
}
function imageSrc(preview: FilePreviewResult): string | null {
  return preview.kind === 'image' &&
    preview.dataBase64 &&
    /^image\/(?:png|jpeg|webp|gif)$/.test(preview.mimeType)
    ? `data:${preview.mimeType};base64,${preview.dataBase64}`
    : null
}
const activeImageSrc = computed(() =>
  activeTab.value ? imageSrc(activeTab.value.preview) : null,
)
function enlargeImage(): void {
  const items = tabs.value.flatMap((tab) => {
    const src = imageSrc(tab.preview)
    return src
      ? [{ id: tab.key, src, name: tab.preview.name, file: tab.request }]
      : []
  })
  openImageViewer({
    owner: props.sessionId,
    items,
    index: Math.max(
      0,
      items.findIndex((item) => item.id === activePath.value),
    ),
  })
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
    ?.scrollIntoView?.({ block: 'center' })
}

const appContext = inject(APP_CONTEXT_KEY, null)
const markdownLinkOptions = {
  notify: (message: string) => appContext?.showToast(message),
}

function handleMarkdownClick(event: MouseEvent): void {
  routeMarkdownClick(
    event,
    `file-preview:${activeTab.value?.path || 'unknown'}`,
    markdownLinkOptions,
  )
}

defineExpose({ openPath, openDirectory, openPreview })

function activateTab(path: string): void {
  activePath.value = path
  currentRequest.value =
    tabs.value.find((tab) => tab.key === path)?.request ?? null
  activeLine.value = null
  openError.value = ''
}

function closeTab(path: string): void {
  const index = tabs.value.findIndex((tab) => tab.key === path)
  if (index < 0) return
  tabs.value = tabs.value.filter((tab) => tab.key !== path)
  if (activePath.value === path)
    activePath.value = tabs.value[Math.max(0, index - 1)]?.key || ''
  currentRequest.value = activeTab.value?.request ?? null
  openError.value = ''
  keepFocusInPane()
}

/** 「+」: show the tree and put the caret in its filter. */
function startOpenFile(): void {
  treeVisible.value = true
  void nextTick(() => {
    filterInput.value?.focus()
    filterInput.value?.select()
  })
}

function closeActiveTab(): void {
  if (activePath.value) closeTab(activePath.value)
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
    const active = tabBar.value?.querySelector<HTMLElement>(
      '.tab-item[data-active] [role="tab"]',
    )
    ;(active ?? root).focus()
  })
}

function toggleSourceMode(): void {
  const tab = activeTab.value
  if (tab) tab.sourceMode = !tab.sourceMode
}

async function copyPath(relative: boolean): Promise<void> {
  const tab = activeTab.value
  if (!tab) return
  await navigator.clipboard.writeText(relative ? tab.path : tab.preview.path)
}

/** What a preview that shows no content says instead. */
const noPreviewNote = computed(() =>
  activeTab.value?.preview.kind === 'directory'
    ? '目录位置 · 可在访达中查看'
    : '此格式暂不支持内容预览。',
)

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
    @scroll.capture.passive="rememberScroll"
  >
    <section class="files-main" aria-label="文件预览">
      <div ref="tabBar" class="file-tab-bar">
        <WorkspaceTabBar
          :model-value="activePath"
          :tabs="tabItems"
          label="已打开文件"
          @update:model-value="activateTab"
          @close="closeTab"
        >
          <template v-if="hasProject" #after>
            <IconButton label="打开文件" @click="startOpenFile">
              <Plus :size="15" />
            </IconButton>
          </template>
          <template v-if="hasProject" #actions>
            <IconButton
              :label="treeVisible ? '隐藏目录树' : '显示目录树'"
              :aria-pressed="treeVisible"
              @click="treeVisible = !treeVisible"
            >
              <PanelRightClose v-if="treeVisible" :size="15" />
              <PanelRightOpen v-else :size="15" />
            </IconButton>
          </template>
        </WorkspaceTabBar>
      </div>

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
          <IconButton label="刷新文件" :disabled="loading" @click="refreshFile"
            ><RefreshCw :size="13"
          /></IconButton>
          <IconButton
            v-if="activeTab.preview.revealable && !isDraftSession"
            label="在访达中显示"
            @click="revealFile"
          >
            <FolderOpen :size="13" />
          </IconButton>
          <Button
            v-if="isMarkdown"
            class="source-toggle"
            size="sm"
            @click="toggleSourceMode"
          >
            {{ activeTab.sourceMode ? '预览' : '源码' }}
          </Button>
          <span ref="copyAnchor" class="copy-anchor">
            <IconButton
              label="复制路径"
              aria-haspopup="menu"
              :aria-expanded="copyMenu"
              @click="copyMenu = !copyMenu"
            >
              <Copy :size="13" />
            </IconButton>
          </span>
          <Menu
            v-model:open="copyMenu"
            :anchor="copyAnchor"
            placement="bottom"
            :width="180"
            dense
            label="复制路径"
          >
            <MenuItem @select="copyPath(true)">复制相对路径</MenuItem>
            <MenuItem @select="copyPath(false)">复制绝对路径</MenuItem>
          </Menu>
        </div>
      </div>

      <div
        ref="previewBody"
        class="file-preview-content"
        tabindex="0"
        :aria-label="activeTab ? `${activeTab.preview.name} 预览` : '文件预览'"
      >
        <p v-if="loading" class="files-muted" role="status">正在读取文件…</p>
        <div v-if="openError" class="files-inline-error" role="alert">
          {{ openError }}
          <LinkButton v-if="activeTab" @click="refreshFile">重试</LinkButton>
        </div>
        <template v-if="activeTab && !openError">
          <button
            v-if="activeImageSrc"
            class="file-image-preview"
            type="button"
            :aria-label="`放大图片：${activeTab.preview.name}`"
            @click="enlargeImage"
          >
            <img :src="activeImageSrc!" :alt="activeTab.preview.name" />
            <span>点击放大</span>
          </button>
          <p v-else-if="activeTab.preview.kind === 'image'" class="files-muted">
            图片超过预览大小限制（8 MiB）。
          </p>
          <div
            v-else-if="isMarkdown && !activeTab.sourceMode"
            class="markdown-body file-markdown-preview"
            v-html="renderedMarkdown"
            @click="handleMarkdownClick"
            @keydown="handleMarkdownKeydown($event, markdownLinkOptions)"
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
          <div v-else class="files-muted">{{ noPreviewNote }}</div>
          <div v-if="activeTab.request.uses?.length" class="file-source-uses">
            <button
              v-for="(use, index) in activeTab.request.uses"
              :key="`${use.nodeKey}:${index}`"
              type="button"
              @click="revealSource(use.nodeKey)"
            >
              定位出处 · {{ use.label }} {{ index + 1 }}
            </button>
          </div>
          <p class="file-preview-meta">
            {{ activeTab.preview.mimeType }} ·
            {{ activeTab.preview.bytes.toLocaleString() }} 字节 · 只读
          </p>
          <small v-if="activeTab.preview.extractedText" class="file-truncated"
            >PDF 提取文本 · 不含原始排版</small
          >
          <small v-if="activeTab.preview.truncated" class="file-truncated">
            预览已截断 · {{ activeTab.preview.bytes.toLocaleString() }} 字节
          </small>
        </template>
        <EmptyState
          v-else-if="!openError"
          class="files-empty"
          title="打开文件"
          :icon="FileText"
          :description="
            hasProject
              ? '从项目目录树中选择文件'
              : '点击对话中的文件名或附件，在这里查看'
          "
        />
      </div>
    </section>

    <aside
      v-if="hasProject && treeVisible"
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
          <SearchField
            ref="filterInput"
            v-model="query"
            size="sm"
            placeholder="筛选文件…"
            aria-label="筛选文件"
            @input="onQueryInput"
            @clear="clearQuery"
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
      <div
        ref="treeList"
        class="file-tree-list"
        role="tree"
        aria-label="项目文件"
      >
        <button
          v-for="row in treeRows"
          :key="row.entry.path"
          type="button"
          class="file-tree-row"
          :data-path="row.entry.path"
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
          <DocumentIcon
            :path="row.entry.name"
            :directory="isDirectory(row.entry)"
            :size="14"
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
.file-source-uses {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-4);
}
.file-source-uses button {
  border: 0;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-row);
  background: var(--surface-hover);
  color: rgb(var(--label-secondary));
  font: var(--font-xs);
  cursor: pointer;
}
.file-preview-meta {
  margin: var(--space-4) 0 0;
  color: rgb(var(--label-tertiary));
  font: var(--font-xs);
  overflow-wrap: anywhere;
}
.file-image-preview {
  display: grid;
  place-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-4);
  border: 0;
  background: transparent;
  color: rgb(var(--label-tertiary));
  cursor: zoom-in;
}
.file-image-preview img {
  max-width: 100%;
  max-height: 65vh;
  object-fit: contain;
}
.file-image-preview span {
  font: var(--font-xs);
}

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

.file-tab-bar {
  flex: none;
  min-width: 0;
}

/* ── breadcrumb ────────────────────────────────────────────────────── */
.file-crumbs-bar {
  display: flex;
  min-height: var(--row-h);
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 0 var(--space-1-5) 0 var(--space-3);
  box-shadow: inset 0 -0.5px 0 var(--hairline);
}

.file-crumbs {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--space-1);
  flex-wrap: wrap;
  padding-block: var(--space-1);
  color: rgb(var(--text-3));
  font: var(--weight-regular) var(--type-caption) var(--font-sans);
}

.crumb {
  min-width: 0;
  overflow-wrap: anywhere;
}

.crumb:last-child {
  max-width: 100%;
  color: rgb(var(--text-2));
}

.crumb-root,
.crumb-sep {
  flex: none;
  color: rgb(var(--text-4));
}

.file-preview-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-0-5);
}

.copy-anchor {
  display: inline-flex;
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
  background: var(--surface-hover);
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
  background: rgb(var(--surface-base));
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
  height: 100%;
  justify-content: center;
}

/* ── tree column (far right) ──────────────────────────────────────── */
.file-tree-column {
  position: relative;
  display: flex;
  min-height: 0;
  flex: none;
  flex-direction: column;
  background: rgb(var(--surface-canvas));
  box-shadow: inset 0.5px 0 0 var(--hairline);
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
  background: var(--surface-hover);
}

.file-tree-row.active {
  color: rgb(var(--label-primary));
  background: var(--surface-active);
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
</style>
