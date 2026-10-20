<script setup lang="ts">
/**
 * 输出 and 来源 on the environment card (UI-S05): one row each, with up to
 * three faces (image thumbnails, file type icons, site icons) and the
 * count; the row opens a menu listing every one. An image opens the
 * lightbox, anything else the resource detail. The menu's label says when
 * only the loaded window is counted (older history not loaded yet).
 *
 * Sources and outputs come from the loaded transcript (resourcesFromSnapshot):
 * attachments, 网页搜索, MCP servers, Skills; files the agent wrote. MCP
 * names missing from the boot tool list are resolved once via skills.tools.
 *
 * Props: sessionId, snapshot, hasMore (older history is not loaded).
 */
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from 'vue'
import { attachmentRawUrl } from '../../../api/attachments'
import { core } from '../../../api/http'
import { useAppContext } from '../../../composables/useAppContext'
import type { ChatSnapshot } from '../../../conversation/types'
import Menu from '../../ui/Menu.vue'
import MenuItem from '../../ui/MenuItem.vue'
import { type SourceToolInfo } from '../../workspace/workspaceSources'
import { resourcesFromSnapshot } from '../resources/resourceIndex'
import { requestResourceDetail } from '../resources/resourceEvents'
import { openResourceImages } from '../resources/resourceImages'
import {
  PROVENANCE_LABEL,
  type DisplayResource,
} from '../resources/resourceModel'
import ResourceIcon from '../resources/ResourceIcon.vue'
import { elementOf } from '../../ui/elementOf'
import EnvironmentRow from './EnvironmentRow.vue'

const props = defineProps<{
  sessionId: string
  snapshot: ChatSnapshot
  hasMore?: boolean
}>()

const ctx = useAppContext()
/** `skills.tools` fetched once an MCP call is missing from the boot list. */
const fetchedTools = shallowRef<SourceToolInfo[] | null>(null)
let toolsRequested = false
const toolCatalog = computed<readonly SourceToolInfo[]>(
  () => fetchedTools.value ?? ctx.boot.value?.tools ?? [],
)
const resources = computed(() =>
  resourcesFromSnapshot(props.snapshot, { tools: toolCatalog.value }),
)
// Tool names never change once a row exists: rescan only for new rows.
watch(
  () => props.snapshot.order.length,
  () => {
    const snapshot = props.snapshot
    if (toolsRequested) return
    const known = new Set(toolCatalog.value.map((tool) => tool.name))
    const unresolved = snapshot.order.some((key) => {
      const node = snapshot.nodes.get(key)
      return (
        node?.kind === 'tool' &&
        node.data.name.startsWith('mcp_') &&
        !known.has(node.data.name)
      )
    })
    if (!unresolved) return
    toolsRequested = true
    void core('skills.tools')
      .then((list) => {
        if (Array.isArray(list)) fetchedTools.value = list
      })
      .catch(() => undefined)
  },
  { immediate: true },
)

const groups = computed(() =>
  [
    {
      key: 'outputs' as const,
      label: '输出',
      all: '全部输出',
      loaded: '已加载输出',
      items: resources.value.outputs,
    },
    {
      key: 'sources' as const,
      label: '来源',
      all: '全部来源',
      loaded: '已加载来源',
      items: resources.value.sources,
    },
  ].filter((group) => group.items.length),
)
const everything = computed(() => [
  ...resources.value.sources,
  ...resources.value.outputs,
])

const anchors: Record<string, HTMLElement | null> = {}
const openMenu = ref<'outputs' | 'sources' | null>(null)

/**
 * Escape closes an open menu first: a click leaves focus on the row, out of
 * the menu's own key handling, and the card must not close instead.
 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !openMenu.value) return
  if (event.defaultPrevented || event.isComposing) return
  event.preventDefault()
  openMenu.value = null
}
onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))

function isImage(resource: DisplayResource): boolean {
  return resource.kind === 'image' && Boolean(resource.attachmentId)
}
function uses(resource: DisplayResource): string {
  return resource.uses && resource.uses.length > 1
    ? `×${resource.uses.length}`
    : ''
}
function select(resource: DisplayResource): void {
  if (isImage(resource))
    openResourceImages(resource, props.sessionId, everything.value)
  else requestResourceDetail(resource, props.sessionId)
}
</script>

<template>
  <div v-if="groups.length" class="resources">
    <template v-for="group in groups" :key="group.key">
      <EnvironmentRow
        :ref="(c) => (anchors[group.key] = elementOf(c))"
        :data-row="group.key"
        :label="group.label"
        :value="String(group.items.length)"
        menu
        :expanded="openMenu === group.key"
        @click="openMenu = openMenu === group.key ? null : group.key"
      >
        <template #lead>
          <span class="faces">
            <template v-for="item in group.items.slice(0, 3)" :key="item.id">
              <img
                v-if="isImage(item)"
                class="thumb"
                :src="attachmentRawUrl(item.attachmentId!)"
                alt=""
                loading="lazy"
                data-resource-face
              />
              <span v-else class="face" data-resource-face
                ><ResourceIcon
                  :resource="item"
                  :session-id="sessionId"
                  :size="14"
              /></span>
            </template>
          </span>
        </template>
      </EnvironmentRow>
      <Menu
        :open="openMenu === group.key"
        :anchor="anchors[group.key] ?? null"
        placement="bottom"
        :width="264"
        dense
        :label="group.all"
        @update:open="(next: boolean) => !next && (openMenu = null)"
      >
        <MenuItem variant="label"
          >{{ hasMore ? group.loaded : group.all }} ·
          {{ group.items.length }}</MenuItem
        >
        <MenuItem
          v-for="item in group.items"
          :key="item.id"
          class="resource-menu-item"
          @select="select(item)"
        >
          <template #icon>
            <img
              v-if="isImage(item)"
              class="menu-thumb"
              :src="attachmentRawUrl(item.attachmentId!)"
              alt=""
              loading="lazy"
            />
            <ResourceIcon
              v-else
              :resource="item"
              :session-id="sessionId"
              :size="16"
            />
          </template>
          <span class="name">{{ item.label }}</span
          ><span class="kind"
            >{{ PROVENANCE_LABEL[item.provenance]
            }}<template v-if="item.kind === 'web' || item.kind === 'github'">
              · {{ item.subtitle }}</template
            >
            {{ uses(item) }}</span
          >
        </MenuItem>
      </Menu>
    </template>
  </div>
</template>

<style scoped>
.resources {
  display: flex;
  flex-direction: column;
  gap: var(--space-0-5);
}

.faces {
  display: inline-flex;
  align-items: center;
}

/* Overlapping faces, each ringed in the card fill. */
.faces > * + * {
  margin-left: calc(-1 * var(--space-1));
}

.face,
.thumb {
  display: inline-grid;
  width: var(--icon-lg);
  height: var(--icon-lg);
  place-items: center;
  border-radius: var(--r-xs);
  background: rgb(var(--surface-base));
  box-shadow: 0 0 0 1.5px rgb(var(--env-card-fill));
}

.thumb {
  object-fit: cover;
}

.menu-thumb {
  width: var(--icon-md);
  height: var(--icon-md);
  border-radius: var(--r-xs);
  object-fit: cover;
}

.resource-menu-item :deep(.item-label) {
  overflow: visible;
  white-space: normal;
  text-overflow: clip;
  overflow-wrap: anywhere;
}

.name,
.kind {
  display: block;
}

.kind {
  color: rgb(var(--text-3));
  font: var(--font-xxxs);
}
</style>
