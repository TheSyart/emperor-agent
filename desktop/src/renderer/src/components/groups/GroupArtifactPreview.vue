<script setup lang="ts">
/** Read-only preview through the same authorized reference as the attachment. */
import { ref, watch } from 'vue'
import { core } from '../../api/http'
import Modal from '../ui/Modal.vue'
import { openImageViewer } from '../ui/imageViewer'

const props = defineProps<{
  groupId: string
  artifact: { ref: string; name: string; mimeType: string } | null
}>()
const open = defineModel<boolean>('open', { default: false })
const loading = ref(false)
const text = ref('')
const failed = ref('')
let generation = 0

async function load(): Promise<void> {
  const artifact = props.artifact
  if (!open.value || !artifact) return
  const run = ++generation
  loading.value = true
  text.value = ''
  failed.value = ''
  try {
    const reference = await core('references.resolve', {
      sessionId: props.groupId,
      sourceMessageId: 'group-artifact-preview',
      href: artifact.ref,
      label: artifact.name,
    })
    if (!reference.available || !reference.id)
      throw new Error('公开成果不存在或已被移除。')
    if (
      artifact.mimeType.startsWith('image/') ||
      /\.(png|jpe?g|gif|webp)$/i.test(artifact.name)
    ) {
      const result = await core('references.image', {
        sessionId: props.groupId,
        referenceId: reference.id,
      })
      if (result.kind !== 'image' || !result.dataBase64)
        throw new Error('这张图片暂时无法预览。')
      if (run === generation) {
        openImageViewer({
          owner: props.groupId,
          items: [
            {
              id: artifact.ref,
              name: artifact.name,
              src: `data:${result.mimeType};base64,${result.dataBase64}`,
              file: {
                owner: props.groupId,
                target: {
                  source: 'reference',
                  sessionId: props.groupId,
                  referenceId: reference.id,
                },
              },
            },
          ],
        })
        open.value = false
      }
    } else {
      const result = await core('files.preview', {
        source: 'reference',
        sessionId: props.groupId,
        referenceId: reference.id,
      })
      if (run === generation)
        text.value = result.content || '这个文件没有可显示的文本内容。'
    }
  } catch (error) {
    if (run === generation)
      failed.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (run === generation) loading.value = false
  }
}
watch(
  () => [open.value, props.artifact?.ref],
  () => void load(),
  { immediate: true },
)
</script>

<template>
  <Modal v-model:open="open" :title="artifact?.name" :width="680" exempt>
    <p v-if="loading" class="status">读取公开成果…</p>
    <p v-else-if="failed" class="status">{{ failed }}</p>
    <pre v-else class="content" data-artifact-preview-content>{{ text }}</pre>
  </Modal>
</template>

<style scoped>
.status {
  margin: 0;
  color: rgb(var(--text-3));
  font-size: var(--fs-xs);
}
.content {
  max-height: 60vh;
  margin: 0;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: rgb(var(--text-1));
  font: var(--font-s);
}
</style>
