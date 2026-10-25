<script setup lang="ts">
/**
 * FileMediaPreview — a video, a song or a picture of the Files pane
 * (BUG-05, BUG-10): the native player, or the picture, on the
 * `app://workspace-media/<token>` address Core grants (files.mediaUrl; main
 * streams it with Range support). A picture Core sent inline (`src`, a
 * data: URL) needs no address; one past the inline limit, or the PNG macOS
 * made of a HEIC or TIFF, comes from the address.
 *
 * A failed load asks Core once more (useMediaAddress). A new address means
 * the old grant ran out: a video or a song plays on from where it was. The
 * same address means the file cannot be decoded here (HEVC, ProRes …): it
 * says so and offers 「用默认应用打开」 / 「在访达中显示」. A file removed
 * meanwhile says 「文件已不存在」.
 *
 * Props: target (the tab's preview input), name, kind, openable, src (an
 * inline picture).
 * Emits: enlarge(url) when a picture is clicked.
 */
import { computed } from 'vue'
import type { FilePreviewInput } from '@emperor/core/api'
import FileOpenActions from './FileOpenActions.vue'
import { useMediaAddress } from './useFileAddress'

const props = withDefaults(
  defineProps<{
    target: FilePreviewInput
    name: string
    kind?: 'video' | 'audio' | 'image'
    openable?: boolean
    src?: string
  }>(),
  { kind: 'video', openable: true, src: undefined },
)
const emit = defineEmits<{ enlarge: [url: string] }>()

const media = useMediaAddress(() => (props.src ? null : props.target))
const shown = computed(() => props.src || media.url.value)
const UNPLAYABLE = {
  video: '这个视频的编码无法在应用里播放',
  audio: '这段音频的编码无法在应用里播放',
  image: '这张图片无法在应用里显示',
} as const
let resumeAt = 0

async function onError(event: Event): Promise<void> {
  const element = event.target as HTMLMediaElement
  resumeAt = 'currentTime' in element ? element.currentTime || 0 : 0
  await media.failed()
}

function onLoaded(event: Event): void {
  media.loaded()
  const element = event.target as HTMLMediaElement
  if (resumeAt > 0 && 'currentTime' in element) element.currentTime = resumeAt
  resumeAt = 0
}
</script>

<template>
  <template v-if="src || media.state.value === 'ready'">
    <video
      v-if="kind === 'video'"
      class="file-video"
      controls
      preload="metadata"
      :src="shown"
      :aria-label="name"
      @error="onError"
      @loadedmetadata="onLoaded"
    ></video>
    <audio
      v-else-if="kind === 'audio'"
      class="file-audio"
      controls
      preload="metadata"
      :src="shown"
      :aria-label="name"
      @error="onError"
      @loadedmetadata="onLoaded"
    ></audio>
    <button
      v-else
      class="file-image-preview"
      type="button"
      :aria-label="`放大图片：${name}`"
      @click="emit('enlarge', shown)"
    >
      <img :src="shown" :alt="name" @error="onError" @load="onLoaded" />
      <span>点击放大</span>
    </button>
  </template>
  <div v-else-if="media.state.value === 'unplayable'" class="file-media-note">
    <p>{{ UNPLAYABLE[kind] }}</p>
    <FileOpenActions :target="target" :openable="openable" />
  </div>
  <p v-else-if="media.state.value === 'missing'" class="file-media-muted">
    文件已不存在
  </p>
  <p
    v-else-if="media.state.value === 'failed'"
    class="file-media-muted"
    role="alert"
  >
    {{ media.failure.value }}
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

.file-audio {
  display: block;
  width: 100%;
}

.file-image-preview {
  display: grid;
  place-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-4);
  border: 0;
  background: transparent;
  color: rgb(var(--text-3));
  cursor: zoom-in;
}

.file-image-preview img {
  max-width: 100%;
  max-height: 65vh;
  object-fit: contain;
}

.file-image-preview span {
  font: var(--font-xs);
}

.file-media-note {
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

.file-media-note p {
  margin: 0;
}

.file-media-muted {
  margin: 0;
  padding: var(--space-2);
  color: rgb(var(--text-3));
  font: var(--font-xs);
}
</style>
