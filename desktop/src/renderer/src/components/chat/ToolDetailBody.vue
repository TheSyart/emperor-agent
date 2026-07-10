<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ToolArtifactRef, ToolSegment } from '../../types'
import { invokeCore } from '../../api/backend'
import { compactJson } from '../../utils/format'
import ExpandableText from './ExpandableText.vue'
import MediaPreviewGrid from './MediaPreviewGrid.vue'
import SubagentTrail from './SubagentTrail.vue'
import { fullOutputRef } from './toolDisplay'

const props = defineProps<{ segment: ToolSegment }>()

const fullOutput = ref('')
const fullOutputLoading = ref(false)
const fullOutputError = ref('')
const fullOutputAvailable = computed(
  () => !fullOutput.value && Boolean(fullOutputRef(props.segment)),
)

const inputText = computed(() => fullJson(props.segment.arguments))
const outputText = computed(() => {
  if (fullOutput.value) return fullOutput.value
  if (props.segment.output)
    return props.segment.outputTruncated
      ? `${props.segment.output}\n\n[输出已截断]`
      : props.segment.output
  if (props.segment.outputMissing && props.segment.summary)
    return `历史事件仅保存摘要：\n${props.segment.summary}`
  return (
    props.segment.summary ||
    (props.segment.status === 'running' ? '等待结果...' : '已记录执行结果')
  )
})

async function loadFullOutput() {
  const refPath = fullOutputRef(props.segment)
  if (!refPath || fullOutputLoading.value) return
  fullOutputLoading.value = true
  fullOutputError.value = ''
  try {
    const result = await invokeCore('tools.readResult', { ref: refPath })
    fullOutput.value = result.content
  } catch {
    fullOutputError.value = '完整输出加载失败'
  } finally {
    fullOutputLoading.value = false
  }
}
const artifacts = computed(() => props.segment.artifacts || [])
const mediaItems = computed(() =>
  artifacts.value.map((artifact) => artifact.media).filter(isImageMedia),
)
const metadata = computed(() => props.segment.metadata || {})
const diffText = computed(() =>
  typeof metadata.value.diff === 'string' ? metadata.value.diff : '',
)
const hasInput = computed(() => Boolean(inputText.value))
const hasOutput = computed(() => Boolean(outputText.value))
const hasArtifacts = computed(() => artifacts.value.length > 0)
const hasMedia = computed(() => mediaItems.value.length > 0)
const hasDiff = computed(() => Boolean(diffText.value))
const hasEvidence = computed(
  () => hasMedia.value || hasArtifacts.value || hasDiff.value,
)
const hasBody = computed(() =>
  Boolean(
    hasInput.value ||
    hasOutput.value ||
    hasEvidence.value ||
    props.segment.subagents?.length ||
    props.segment.todos?.length,
  ),
)

function fullJson(value: unknown) {
  if (!value || typeof value !== 'object') return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return compactJson(value)
  }
}

function todoMarker(status: string) {
  if (status === 'completed') return '✓'
  if (status === 'in_progress') return '●'
  return '□'
}

function artifactKind(artifact: ToolArtifactRef) {
  return artifact.kind || 'artifact'
}

function artifactSize(artifact: ToolArtifactRef) {
  if (!artifact.bytes && artifact.bytes !== 0) return ''
  if (artifact.bytes < 1024) return `${artifact.bytes} B`
  if (artifact.bytes < 1024 * 1024)
    return `${(artifact.bytes / 1024).toFixed(1)} KB`
  return `${(artifact.bytes / 1024 / 1024).toFixed(1)} MB`
}

function isImageMedia(
  media: ToolArtifactRef['media'],
): media is NonNullable<ToolArtifactRef['media']> {
  return Boolean(media && media.kind === 'image')
}
</script>

<template>
  <div v-if="hasBody" class="activity-body tool-detail-body">
    <div class="tool-io-grid">
      <div v-if="hasInput" class="tool-io-panel">
        <span>{{ props.segment.inputLabel || 'IN' }}</span>
        <ExpandableText
          class="tool-summary tool-code"
          :text="inputText"
          :limit="360"
        />
      </div>
      <div v-if="hasOutput" class="tool-io-panel">
        <span>{{ props.segment.outputLabel || 'OUT' }}</span>
        <ExpandableText class="tool-summary" :text="outputText" :limit="360" />
        <button
          v-if="fullOutputAvailable"
          type="button"
          class="tool-full-output-btn"
          :disabled="fullOutputLoading"
          @click="loadFullOutput"
        >
          {{ fullOutputLoading ? '加载中...' : '查看完整输出' }}
        </button>
        <small v-if="fullOutputError" class="tool-full-output-error">{{
          fullOutputError
        }}</small>
      </div>
    </div>

    <div v-if="hasEvidence" class="tool-evidence">
      <div v-if="hasMedia" class="tool-media">
        <span>MEDIA</span>
        <MediaPreviewGrid :items="mediaItems" />
      </div>
      <div v-if="hasArtifacts" class="tool-artifacts">
        <span>ARTIFACTS</span>
        <div class="tool-artifact-list">
          <div
            v-for="artifact in artifacts"
            :key="`${artifact.kind || 'artifact'}:${artifact.path}`"
            class="tool-artifact-item"
          >
            <strong>{{ artifact.path }}</strong>
            <em>{{ artifactKind(artifact) }}</em>
            <small v-if="artifactSize(artifact)">{{
              artifactSize(artifact)
            }}</small>
          </div>
        </div>
      </div>
      <div v-if="hasDiff" class="tool-diff">
        <span>DIFF</span>
        <ExpandableText
          class="tool-summary tool-code"
          :text="diffText"
          :limit="900"
        />
      </div>
    </div>

    <div v-if="props.segment.todos?.length" class="tool-todo-list">
      <div class="tool-todo-head">
        <strong>Update Todos</strong>
        <span>{{ props.segment.todos.length }} 项</span>
      </div>
      <div class="tool-todo-items">
        <div
          v-for="todo in props.segment.todos"
          :key="todo.id"
          class="tool-todo-item"
          :class="todo.status"
        >
          <span>{{ todoMarker(todo.status) }}</span>
          <em>{{ todo.id }}</em>
          <p>{{ todo.content }}</p>
        </div>
      </div>
    </div>

    <SubagentTrail
      v-if="props.segment.subagents?.length"
      :subagents="props.segment.subagents"
    />
  </div>
</template>
