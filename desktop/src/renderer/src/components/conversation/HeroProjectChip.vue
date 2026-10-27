<script setup lang="ts">
/**
 * HeroProjectChip — the Build home's project in the composer bar (MOD-03,
 * preview A): a gold chip with the project the session will run in, then
 * its branch. Until a project is picked the chip says 「选择项目」 with a
 * stronger gold ring (the send button waits, 「先选一个项目」). The chip
 * opens a menu of recent projects and 「打开文件夹…」.
 *
 * Props: project (null: none yet), branch (null: none or not Git),
 * projects (the menu, most recent first). Emits: pick, open-folder.
 */
import { GitBranch } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import { DsFolderClose, DsPlus } from '../icons/ds'
import Chip from '../ui/Chip.vue'
import Menu from '../ui/Menu.vue'
import MenuItem from '../ui/MenuItem.vue'
import type { ProjectInfo } from '../../types'
import type { RecentProject } from './heroProjects'

const props = defineProps<{
  project: ProjectInfo | null
  branch: string | null
  projects: RecentProject[]
}>()
const emit = defineEmits<{
  pick: [project: RecentProject]
  'open-folder': []
}>()

const open = ref(false)
const anchor = ref<HTMLElement | null>(null)

const name = computed(() =>
  props.project
    ? props.project.project_name ||
      props.project.project_path.split('/').pop() ||
      props.project.project_path
    : '',
)
const chipLabel = computed(() =>
  props.project ? `项目：${name.value}，换一个项目` : '选择项目',
)

function pick(project: RecentProject): void {
  open.value = false
  if (project.id !== props.project?.project_id) emit('pick', project)
}
</script>

<template>
  <span ref="anchor" class="hero-project">
    <Chip
      tone="accent"
      chevron
      :active="open"
      :aria-label="chipLabel"
      :aria-expanded="open"
      aria-haspopup="menu"
      :title="project?.project_path || '先选一个项目'"
      data-hero-project
      :data-required="project ? undefined : true"
      @click="open = !open"
    >
      <template #icon><DsFolderClose :size="14" /></template>
      {{ project ? name : '选择项目' }}
    </Chip>
  </span>
  <span v-if="project && branch" class="branch" data-hero-branch>
    <GitBranch :size="14" :stroke-width="1.5" class="branch-glyph" />
    <span class="branch-name">{{ branch }}</span>
  </span>
  <Menu
    v-model:open="open"
    :anchor="anchor"
    :width="260"
    label="选择项目"
    align="start"
  >
    <MenuItem
      v-for="item in projects"
      :key="item.id"
      :selected="item.id === project?.project_id"
      @select="pick(item)"
    >
      <template #icon><DsFolderClose :size="16" /></template>
      {{ item.name }}
    </MenuItem>
    <MenuItem v-if="projects.length" variant="separator" />
    <MenuItem @select="emit('open-folder')">
      <template #icon><DsPlus :size="16" /></template>
      打开文件夹…
    </MenuItem>
  </Menu>
</template>

<style scoped>
.hero-project {
  display: inline-flex;
  min-width: 0;
}

/* No project yet: the gold says 「pick one」 louder. */
.hero-project :deep([data-required]) {
  box-shadow: inset 0 0 0 1px rgb(var(--accent) / 0.55);
}

.branch {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  max-width: 180px;
  height: var(--space-7);
  padding: 0 var(--space-2);
  border-radius: var(--radius-pill);
  color: rgb(var(--text-3));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.branch-glyph {
  flex: none;
}

.branch-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
