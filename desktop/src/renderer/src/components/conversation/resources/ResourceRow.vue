<script setup lang="ts">
import Badge from '../../ui/Badge.vue'
import { ChevronRight } from 'lucide-vue-next'
import { attachmentRawUrl } from '../../../api/attachments'
import { openResourceImages } from './resourceImages'
import { requestResourceDetail } from './resourceEvents'
import ResourceIcon from './ResourceIcon.vue'
import { PROVENANCE_LABEL, type DisplayResource } from './resourceModel'
defineProps<{
  resource: DisplayResource
  sessionId: string
  group?: readonly DisplayResource[]
}>()
</script>
<template>
  <div
    class="row resource-sidebar-row"
    :data-kind="resource.kind"
    :title="resource.href || resource.label"
  >
    <button
      v-if="resource.kind === 'image' && resource.attachmentId"
      class="resource-thumb-open"
      type="button"
      :aria-label="`放大图片：${resource.label}`"
      @click="openResourceImages(resource, sessionId, group)"
    >
      <img
        v-if="resource.kind === 'image' && resource.attachmentId"
        class="resource-thumb"
        :src="attachmentRawUrl(resource.attachmentId)"
        alt=""
        loading="lazy"
      /></button
    ><span v-else class="resource-row-icon"
      ><ResourceIcon
        :resource="resource"
        :session-id="sessionId"
        :size="20" /></span
    ><button
      type="button"
      class="resource-row-content"
      @click="requestResourceDetail(resource, sessionId)"
    >
      <span class="resource-row-label">{{ resource.label }}</span
      ><span class="resource-row-subtitle"
        >{{ PROVENANCE_LABEL[resource.provenance]
        }}<template v-if="resource.kind === 'github'">
          · {{ resource.subtitle }}</template
        ><template v-else-if="resource.kind === 'web'">
          · {{ resource.subtitle }}</template
        ></span
      ></button
    ><Badge
      v-if="resource.uses && resource.uses.length > 1"
      variant="count"
      :label="`×${resource.uses.length}`"
    /><ChevronRight class="resource-row-arrow" :size="12" />
  </div>
</template>
<style scoped>
.resource-thumb-open {
  padding: 0;
  border: 0;
  background: transparent;
  cursor: zoom-in;
  flex: none;
}
.resource-sidebar-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-width: 0;
  min-height: 56px;
  padding: var(--space-2);
  border: 0;
  border-radius: var(--radius-row);
  background: transparent;
  color: rgb(var(--label-primary));
  text-align: left;
  cursor: pointer;
}
.resource-sidebar-row:hover {
  background: var(--surface-hover);
}
.resource-row-icon,
.resource-thumb {
  display: grid;
  place-items: center;
  flex: none;
  width: 28px;
  height: 32px;
  color: rgb(var(--label-secondary));
}
.resource-thumb {
  object-fit: cover;
  border-radius: var(--radius-xs);
}
.resource-row-content {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  text-align: left;
  color: inherit;
  cursor: pointer;
}
.resource-row-label {
  display: block;
  overflow-wrap: anywhere;
  font: var(--font-s);
}
.resource-row-subtitle {
  display: block;
  margin-top: var(--space-0-5);
  font: var(--font-xxs);
  color: rgb(var(--label-tertiary));
  overflow-wrap: anywhere;
}
.resource-row-arrow {
  flex: none;
  color: rgb(var(--label-tertiary));
  opacity: 0;
}
.resource-sidebar-row:hover .resource-row-arrow,
.resource-sidebar-row:focus-visible .resource-row-arrow {
  opacity: 1;
}
.resource-sidebar-row:focus-visible {
  outline: 2px solid rgb(var(--focus-ring));
  outline-offset: 2px;
}
</style>
