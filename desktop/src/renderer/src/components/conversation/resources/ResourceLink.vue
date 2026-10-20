<script setup lang="ts">
/**
 * ResourceLink — an inline reference in a reply: a 12px source icon (file
 * type, or the site icon when 显示网站图标 is on) and the name in
 * `--text-link` (UI-S03).
 */
import { useChatContext } from '../chatContext'
import ResourceIcon from './ResourceIcon.vue'
import { requestResourceOpen } from './resourceEvents'
import type { DisplayResource } from './resourceModel'
defineProps<{ resource: DisplayResource }>()
const { sessionId } = useChatContext()
</script>
<template>
  <span class="resource-inline"
    ><a
      :href="resource.href"
      :title="resource.href"
      @click.prevent="requestResourceOpen(resource, sessionId())"
      ><ResourceIcon :resource="resource" :size="12" /><span>{{
        resource.label
      }}</span></a
    ></span
  >
</template>
<style scoped>
.resource-inline {
  display: inline-flex;
  align-items: center;
  max-width: calc(100% - var(--space-2));
  margin-inline: var(--space-1);
  border-radius: var(--radius-xs);
  background: transparent;
  vertical-align: baseline;
  color: rgb(var(--text-link));
  font-weight: 500;
  line-height: 1.85;
}
.resource-inline a {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  min-width: 0;
  padding: 0 var(--space-0-5);
  border-radius: inherit;
  color: inherit;
  overflow-wrap: anywhere;
}
.resource-inline a > span:last-child {
  min-width: 0;
  overflow-wrap: anywhere;
}
.resource-inline a:hover {
  text-decoration: underline;
  text-underline-offset: 4px;
  background: var(--surface-hover);
}
.resource-inline a:focus-visible {
  outline: 2px solid rgb(var(--focus-ring));
  outline-offset: 3px;
}
</style>
