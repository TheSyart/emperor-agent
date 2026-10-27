<script setup lang="ts">
/**
 * HeroRecentProjects — the Build home's 「最近的项目」 under the composer
 * (MOD-03, preview A): a card per recent project (name, then 「3 个会话 ·
 * 4 天前」 or 「1 个在运行」; the session's own project marked current) and
 * a last card 「打开文件夹…」. A folder dropped anywhere on the block binds
 * it too; a dropped file is turned away. With no project at all only
 * 「打开文件夹…」 shows.
 *
 * Props: projects (heroProjects.ts, most recent first), currentId?, now?
 * (tests). Emits: pick, open-folder, drop-folder (the folder's File),
 * drop-rejected.
 */
import { computed, ref } from 'vue'
import { DsFolderClose, DsPlus } from '../icons/ds'
import Surface from '../ui/Surface.vue'
import {
  droppedFolder,
  recentProjectMeta,
  type RecentProject,
} from './heroProjects'

const props = defineProps<{
  projects: RecentProject[]
  currentId?: string | null
  now?: number
}>()
const emit = defineEmits<{
  pick: [project: RecentProject]
  'open-folder': []
  'drop-folder': [file: File]
  'drop-rejected': []
}>()

const cards = computed(() =>
  props.projects.map((project) => ({
    project,
    meta: recentProjectMeta(project, props.now),
    current: project.id === props.currentId,
  })),
)

/** Nested enter / leave pairs while something is dragged over the block. */
const dragDepth = ref(0)
const dragging = computed(() => dragDepth.value > 0)

function carriesFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types
  return !types || Array.from(types).includes('Files')
}

function onDragEnter(event: DragEvent): void {
  if (!carriesFiles(event)) return
  event.preventDefault()
  dragDepth.value += 1
}

function onDragOver(event: DragEvent): void {
  if (!carriesFiles(event)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'link'
}

function onDragLeave(): void {
  dragDepth.value = Math.max(0, dragDepth.value - 1)
}

function onDrop(event: DragEvent): void {
  event.preventDefault()
  event.stopPropagation()
  dragDepth.value = 0
  const drop = droppedFolder(event.dataTransfer)
  if (drop.kind === 'folder') emit('drop-folder', drop.file)
  else if (drop.kind === 'file') emit('drop-rejected')
}
</script>

<template>
  <section
    class="hero-recent-projects"
    aria-label="最近的项目"
    :data-drag="dragging || undefined"
    :style="{ '--cards': cards.length + 1 }"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <h2 v-if="cards.length" class="heading">最近的项目</h2>
    <div class="cards">
      <Surface
        v-for="{ project, meta, current } in cards"
        :key="project.id"
        as="button"
        interactive
        pad="sm"
        class="card"
        :data-project-id="project.id"
        :aria-current="current ? 'true' : undefined"
        :title="project.path"
        @click="emit('pick', project)"
      >
        <span class="title">
          <DsFolderClose :size="16" class="glyph" />
          <span class="name">{{ project.name }}</span>
        </span>
        <span class="meta">{{ meta }}</span>
      </Surface>
      <Surface
        as="button"
        interactive
        pad="sm"
        class="card open"
        data-open-folder
        @click="emit('open-folder')"
      >
        <span class="title">
          <DsPlus :size="16" class="glyph" />
          <span class="name">打开文件夹…</span>
        </span>
        <span class="meta">或把文件夹拖到这里</span>
      </Surface>
    </div>
  </section>
</template>

<style scoped>
.hero-recent-projects {
  container: recent-projects / inline-size;
  display: flex;
  flex-direction: column;
  gap: var(--space-2-5);
  box-sizing: border-box;
  width: min(
    calc(var(--composer-card-max) + 2 * var(--composer-clearance)),
    100%
  );
  padding: 0 var(--composer-clearance);
}

.heading {
  margin: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-weight: var(--weight-medium);
  letter-spacing: 0.04em;
  color: rgb(var(--text-3));
}

.cards {
  display: grid;
  grid-template-columns: repeat(var(--cards), minmax(0, 1fr));
  gap: var(--space-2-5);
}

@container recent-projects (max-width: 520px) {
  .cards {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.card {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
  cursor: pointer;
}

.card[aria-current='true'] {
  box-shadow: inset 0 0 0 1px rgb(var(--accent) / 0.45);
}

.title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: var(--weight-medium);
  color: rgb(var(--text-1));
}

.glyph {
  flex: none;
  color: rgb(var(--text-3));
}

.name,
.meta {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--text-3));
}

/* A folder over the block: the drop target lights up. */
.hero-recent-projects[data-drag] .open {
  box-shadow: inset 0 0 0 1px rgb(var(--focus-ring) / 0.7);
  background: rgb(var(--accent-soft));
}
</style>
