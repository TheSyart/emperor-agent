<script setup lang="ts">
/**
 * ExploreCard — one 探索 catalog entry: a kind tile, name + publisher, the
 * kind tag, a three-line description, its tags, 「主页」 (opens the source
 * in the browser) and 「安装」 (「已安装」 once it is there). A Plugin card
 * notes that URL Plugins stay inactive until their signature verifies.
 *
 * Props: entry, installed?. Emits: install(), homepage().
 */
import { computed } from 'vue'
import { ExternalLink, Plug, Puzzle, Sparkles } from 'lucide-vue-next'
import Button from '../../ui/Button.vue'
import IconButton from '../../ui/IconButton.vue'
import { StatusBadge } from '../../settings/ui'
import { EXPLORE_KIND_LABELS, type ExploreEntry } from './exploreModel'

const props = withDefaults(
  defineProps<{ entry: ExploreEntry; installed?: boolean }>(),
  { installed: false },
)
const emit = defineEmits<{ install: []; homepage: [] }>()

const GLYPHS = { skill: Sparkles, mcp: Plug, plugin: Puzzle } as const

const glyph = computed(() => GLYPHS[props.entry.kind])
const titleId = computed(() => `explore-card-${props.entry.id}`)
</script>

<template>
  <li
    class="explore-card"
    :data-entry-id="entry.id"
    :data-kind="entry.kind"
    :aria-labelledby="titleId"
  >
    <div class="head">
      <span class="tile" aria-hidden="true">
        <component :is="glyph" :size="18" :stroke-width="1.75" />
      </span>
      <div class="titles">
        <h3 :id="titleId" class="name">{{ entry.name }}</h3>
        <span class="publisher">{{ entry.publisher }}</span>
      </div>
      <StatusBadge class="kind">{{
        EXPLORE_KIND_LABELS[entry.kind]
      }}</StatusBadge>
    </div>
    <p class="description">{{ entry.description }}</p>
    <p v-if="entry.kind === 'plugin'" class="note">
      从 URL 安装的插件需通过签名验证才会激活。
    </p>
    <div class="foot">
      <ul v-if="entry.tags.length" class="tags" aria-label="标签">
        <li v-for="tag in entry.tags" :key="tag" class="tag">{{ tag }}</li>
      </ul>
      <div class="actions">
        <IconButton
          :label="`在浏览器中打开「${entry.name}」的主页`"
          data-action="homepage"
          @click="emit('homepage')"
        >
          <ExternalLink :size="15" />
        </IconButton>
        <Button
          size="sm"
          :variant="installed ? 'ghost' : 'outline'"
          :disabled="installed"
          data-action="install"
          :aria-label="
            installed ? `「${entry.name}」已安装` : `安装「${entry.name}」`
          "
          @click="emit('install')"
        >
          {{ installed ? '已安装' : '安装' }}
        </Button>
      </div>
    </div>
  </li>
</template>

<style scoped>
.explore-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2-5);
  min-width: 0;
  padding: var(--space-4);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-card);
  background: rgb(var(--bg-layer-3));
  list-style: none;
}

.head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  min-width: 0;
}

.tile {
  display: inline-grid;
  flex: none;
  place-items: center;
  width: var(--space-8);
  height: var(--space-8);
  border-radius: var(--radius-row);
  background: var(--interactive-bg-hover);
  color: rgb(var(--label-secondary));
}

.explore-card[data-kind='skill'] .tile {
  color: rgb(var(--accent-fill));
}

.titles {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.name {
  margin: 0;
  overflow: hidden;
  color: rgb(var(--label-primary));
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.publisher {
  overflow: hidden;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kind {
  flex: none;
}

.description {
  display: -webkit-box;
  flex: 1;
  margin: 0;
  overflow: hidden;
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  line-clamp: 3;
}

.note {
  margin: 0;
  color: rgb(var(--state-warn-label));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.foot {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.tags {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  gap: var(--space-1);
  min-width: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}

.tag {
  padding: 0 var(--space-1-5);
  border-radius: var(--radius-sm);
  background: var(--interactive-bg-hover);
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxs);
  white-space: nowrap;
}

.actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-1);
  margin-left: auto;
}
</style>
