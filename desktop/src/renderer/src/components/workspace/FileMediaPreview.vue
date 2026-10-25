<script setup lang="ts">
/**
 * FileVideoPreview — a video tab of the Files pane (BUG-05): the native
 * player on the `app://workspace-media/<token>` address Core grants
 * (files.mediaUrl; main streams it with Range support).
 *
 * A failed load asks Core once more. A new address means the old grant ran
 * out (they last ten minutes): it plays on from where it was. The same
 * address means the file is there but Chromium cannot decode it (HEVC,
 * ProRes …): 「这个视频的编码无法在应用里播放」 with 「用默认应用打开」.
 * A file removed meanwhile says 「文件已不存在」.
 *
 * Props: target (the tab's preview input), name (for the player's label).
 */
import { onBeforeUnmount, ref, watch } from 'vue'
import type { FilePreviewInput } from '@emperor/core/api'
import { core } from '../../api/http'
import { openWorkspaceMedia } from '../../api/backend'
import Button from '../ui/Button.vue'

const props = defineProps<{ target: FilePreviewInput; name: string }>()

const MISSING = new Set([
  'workspace_path_missing',
  'reference_attachment_unknown',
])

const url = ref('')
const state = ref<'loading' | 'ready' | 'unplayable' | 'missing' | 'failed'>(
  'loading',
)
const failure = ref('')
const opening = ref(false)
let generation = 0
/** A failed load already asked for a new address (reset once one plays). */
let retried = false
let resumeAt = 0

watch(
  () => JSON.stringify(props.target),
  () => void load(),
  { immediate: true },
)
onBeforeUnmount(() => {
  generation += 1
})

/** A media address for the target; null when it failed (state says why) or went stale. */
async function mediaUrl(): Promise<string | null> {
  const asked = generation
  try {
    const result = await core('files.mediaUrl', { ...props.target })
    return asked === generation ? result.url : null
  } catch (cause) {
    if (asked !== generation) return null
    const code = (cause as { code?: unknown }).code
    state.value =
      typeof code === 'string' && MISSING.has(code) ? 'missing' : 'failed'
    failure.value = cause instanceof Error ? cause.message : String(cause)
    return null
  }
}

async function load(): Promise<void> {
  generation += 1
  retried = false
  resumeAt = 0
  state.value = 'loading'
  failure.value = ''
  const next = await mediaUrl()
  if (next === null) return
  url.value = next
  state.value = 'ready'
}

async function onError(event: Event): Promise<void> {
  if (state.value !== 'ready') return
  resumeAt = (event.target as HTMLVideoElement).currentTime || 0
  if (!retried) {
    retried = true
    const next = await mediaUrl()
    if (next === null) return
    if (next !== url.value) {
      url.value = next
      return
    }
  }
  state.value = 'unplayable'
}

function onLoadedMetadata(event: Event): void {
  retried = false
  if (resumeAt > 0) (event.target as HTMLVideoElement).currentTime = resumeAt
  resumeAt = 0
}

async function openExternally(): Promise<void> {
  opening.value = true
  failure.value = ''
  try {
    const next = await mediaUrl()
    if (next !== null) await openWorkspaceMedia(next)
  } catch (cause) {
    failure.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    opening.value = false
  }
}
</script>

<template>
  <video
    v-if="state === 'ready'"
    class="file-video"
    controls
    preload="metadata"
    :src="url"
    :aria-label="name"
    @error="onError"
    @loadedmetadata="onLoadedMetadata"
  ></video>
  <div v-else-if="state === 'unplayable'" class="file-video-note">
    <p>这个视频的编码无法在应用里播放</p>
    <Button
      variant="secondary"
      size="sm"
      :loading="opening"
      @click="openExternally"
      >用默认应用打开</Button
    >
    <small v-if="failure" role="alert">{{ failure }}</small>
  </div>
  <p v-else-if="state === 'missing'" class="file-video-muted">文件已不存在</p>
  <p v-else-if="state === 'failed'" class="file-video-muted" role="alert">
    {{ failure }}
  </p>
</template>

<style scoped>
.file-video {
  display: block;
  width: 100%;
  max-height: 65vh;
  border-radius: var(--radius-cell);
  background: rgb(var(--surface-sunken));
}

.file-video-note {
  display: grid;
  justify-items: center;
  gap: var(--space-2);
  padding: var(--space-6) var(--space-3);
  border-radius: var(--radius-cell);
  background: rgb(var(--surface-raised));
  color: rgb(var(--text-2));
  font: var(--font-xs);
  text-align: center;
}

.file-video-note p {
  margin: 0;
}

.file-video-note small {
  color: rgb(var(--error));
  font: var(--font-xxs);
}

.file-video-muted {
  margin: 0;
  padding: var(--space-2);
  color: rgb(var(--text-3));
  font: var(--font-xs);
}
</style>
