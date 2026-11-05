<script setup lang="ts">
/** Public files/images inline in a result message, never a separate card. */
import { computed, ref, watch } from 'vue'
import { core } from '../../api/http'
import LinkButton from '../ui/LinkButton.vue'
import DocumentIcon from '../ui/DocumentIcon.vue'
import Tag from '../ui/Tag.vue'
import { formatBytes } from '../conversation/chatFormat'
import type { GroupArtifactFile, GroupTask } from './groupModel'

type Artifact = NonNullable<GroupTask['artifacts']>[number]
const props = defineProps<{
  groupId: string
  artifacts: readonly Artifact[]
  files: readonly GroupArtifactFile[]
}>()
const emit = defineEmits<{
  preview: [input: { ref: string; name: string; mimeType: string }]
  get: [ref: string]
}>()

function fallbackName(ref: string): string {
  const name = ref.split('/').at(-1) || ref
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}
function imageType(name: string, mime: string | undefined): boolean {
  return Boolean(
    mime?.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(name),
  )
}
function sizeLabel(bytes: number | undefined): string {
  return bytes === undefined ? '公开成果' : `${formatBytes(bytes)} · 公开成果`
}
const items = computed(() =>
  props.artifacts.map((artifact) => {
    const file = props.files.find((entry) => entry.artifactRef === artifact.ref)
    const name = file?.name ?? fallbackName(artifact.ref)
    return {
      ...artifact,
      name,
      mimeType: file?.mimeType ?? '',
      size: file?.size,
      image: imageType(name, file?.mimeType),
    }
  }),
)
const images = ref<Record<string, string>>({})
let generation = 0
async function loadImages(): Promise<void> {
  const run = ++generation
  for (const item of items.value.filter((entry) => entry.image)) {
    if (images.value[item.ref]) continue
    try {
      const reference = await core('references.resolve', {
        sessionId: props.groupId,
        sourceMessageId: 'group-artifact',
        href: item.ref,
        label: item.name,
      })
      if (!reference.available || !reference.id) continue
      const image = await core('references.image', {
        sessionId: props.groupId,
        referenceId: reference.id,
      })
      if (
        run === generation &&
        image.kind === 'image' &&
        !image.truncated &&
        image.dataBase64
      )
        images.value = {
          ...images.value,
          [item.ref]: `data:${image.mimeType};base64,${image.dataBase64}`,
        }
    } catch {
      // The ordinary file row remains available if a thumbnail cannot load.
    }
  }
}
watch(
  () => [props.groupId, items.value.map((item) => item.ref).join('\n')],
  () => void loadImages(),
  { immediate: true },
)
</script>

<template>
  <div class="attachments" data-group-artifacts>
    <div
      v-for="item in items"
      :key="`${item.ref}@${item.revision}`"
      class="attachment"
      :class="{ image: item.image && images[item.ref] }"
      :data-artifact="item.ref"
    >
      <template v-if="item.image && images[item.ref]">
        <img class="thumbnail" :src="images[item.ref]" :alt="item.name" />
        <div class="image-meta">
          {{ item.name }} · {{ sizeLabel(item.size) }}
        </div>
      </template>
      <template v-else>
        <Tag
          class="file-pill"
          :label="`${item.name} · ${sizeLabel(item.size)}`"
          @click="
            emit('preview', {
              ref: item.ref,
              name: item.name,
              mimeType: item.mimeType,
            })
          "
        >
          <template #leading>
            <DocumentIcon :path="item.name" :size="18" />
          </template>
        </Tag>
      </template>
      <div class="actions">
        <LinkButton
          :data-artifact-preview="item.ref"
          @click="
            emit('preview', {
              ref: item.ref,
              name: item.name,
              mimeType: item.mimeType,
            })
          "
          >查看</LinkButton
        >
        <LinkButton :data-artifact-get="item.ref" @click="emit('get', item.ref)"
          >获取</LinkButton
        >
      </div>
    </div>
  </div>
</template>

<style scoped>
.attachments {
  display: grid;
  gap: var(--space-3);
  margin-top: var(--space-2-5);
}
.attachment {
  display: grid;
  gap: var(--space-1);
  max-width: 360px;
  min-width: 0;
}
.file-pill {
  max-width: 100%;
}

.file-pill :deep(.label) {
  overflow: hidden;
  text-overflow: ellipsis;
}

.image-meta {
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
}
.actions {
  display: flex;
  gap: var(--space-3);
  padding-left: var(--space-2);
  font-size: var(--fs-xxs);
}
.image .actions {
  padding-left: 0;
}
.thumbnail {
  display: block;
  width: min(320px, 100%);
  max-height: 320px;
  object-fit: contain;
  border-radius: var(--r-md);
  box-shadow: 0 0 0 0.5px var(--hairline);
}
</style>
