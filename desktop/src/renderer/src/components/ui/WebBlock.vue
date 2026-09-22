<script setup lang="ts">
/**
 * WebBlock — dsh web tool surface.
 *
 * Props:
 * - kind: 'search' | 'fetch'.
 * - search: answer? (plain text), sources: WebSource[], truncated?.
 * - fetch: url, statusCode, truncated?.
 * Links are gold (accent-strong) and only http(s) URLs become anchors.
 */
import { computed } from 'vue'
import { linkLabel, safeHref, type WebSource } from './blockTypes'

const props = withDefaults(
  defineProps<{
    kind: 'search' | 'fetch'
    answer?: string
    sources?: WebSource[]
    url?: string
    statusCode?: number
    truncated?: boolean
  }>(),
  {
    answer: undefined,
    sources: () => [],
    url: '',
    statusCode: undefined,
    truncated: false,
  },
)

const empty = computed(() => !props.answer && props.sources.length === 0)
</script>

<template>
  <div v-if="kind === 'search'" class="ds-web" data-web="search">
    <div v-if="answer" class="answer" v-text="answer" />
    <div v-if="empty" class="empty">未找到结果</div>
    <ol v-else-if="sources.length" class="sources">
      <li v-for="(source, index) in sources" :key="index" class="source">
        <a
          v-if="safeHref(source.url)"
          class="link"
          :href="safeHref(source.url)"
          target="_blank"
          rel="noopener noreferrer"
          >{{ linkLabel(source.url, source.title) }}</a
        >
        <span v-else class="link">{{
          linkLabel(source.url, source.title)
        }}</span>
        <div v-if="source.snippet" class="snippet" v-text="source.snippet" />
        <div v-if="source.publishedAt" class="meta">
          {{ source.publishedAt }}
        </div>
      </li>
    </ol>
    <div v-if="truncated" class="meta truncated">来源列表已截断</div>
  </div>
  <div v-else class="ds-web fetch" data-web="fetch">
    <a
      v-if="safeHref(url)"
      class="fetch-url"
      :href="safeHref(url)"
      target="_blank"
      rel="noopener noreferrer"
      >{{ url }}</a
    >
    <span v-else class="fetch-url">{{ url }}</span>
    <div class="fetch-meta">
      <span v-if="statusCode !== undefined" class="status"
        >HTTP {{ statusCode }}</span
      >
      <span v-if="truncated" class="meta">内容已截断</span>
    </div>
  </div>
</template>

<style scoped>
.ds-web {
  padding: var(--space-3) var(--space-3-5);
  color: rgb(var(--label-primary));
  background: rgb(var(--code-block-bg));
  border-radius: var(--radius-card);
}

.answer {
  margin-bottom: var(--space-2);
  font: var(--font-s);
  white-space: pre-wrap;
}

.sources {
  display: flex;
  flex-direction: column;
  gap: var(--space-2-5);
  max-height: 320px;
  margin: 0;
  padding-left: 2.5em;
  overflow-y: auto;
}

.source {
  min-width: 0;
  color: rgb(var(--label-tertiary));
  font: var(--font-xs);
}

.link {
  font-size: var(--fs-s);
  line-height: var(--lh-xs);
  color: rgb(var(--accent-strong));
  text-decoration: none;
  word-break: break-word;
}

a.link:hover,
a.fetch-url:hover {
  text-decoration: underline;
}

.snippet {
  margin-top: 2px;
  font-size: var(--fs-xs);
  line-height: 19px;
  color: rgb(var(--label-secondary));
  word-break: break-word;
}

.meta {
  margin-top: 2px;
  font: var(--font-xs);
  color: rgb(var(--label-tertiary));
}

.truncated {
  margin-top: var(--space-2);
}

.empty {
  font: var(--font-xs);
  color: rgb(var(--label-secondary));
}

.fetch {
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
}

.fetch-url {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  line-height: 19px;
  color: rgb(var(--accent-strong));
  text-decoration: none;
  word-break: break-all;
}

.fetch-meta {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
}

.fetch-meta .meta {
  margin-top: 0;
}

.status {
  font: var(--font-xs);
  color: rgb(var(--label-secondary));
}
</style>
