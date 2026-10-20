<script setup lang="ts">
/**
 * MemoryEditorPane — one memory file editor for Settings › 记忆: a toolbar
 * (file path, 「未保存」 badge, extra controls, 编辑 / 预览 switch), optional
 * content above the editor, a Markdown CodeEditor that takes the remaining
 * height of the `fill` section (⌘S saves) or the rendered preview, and a
 * one-line note under it.
 *
 * Props:
 * - path: file path / label shown in the toolbar (also the editor name).
 * - note?: footnote (what saving does).
 * - readonly?: no editing (Build project memory).
 * - dirty?: shows 「未保存」.
 * - placeholder?.
 * v-model: the draft text.
 * Slots: `toolbar` (controls before the 编辑 / 预览 switch), default
 * (content between the toolbar and the editor, e.g. decision facts).
 * Emits: save (⌘S / Ctrl+S in the editor).
 */
import { ref } from 'vue'
import MarkdownBlock from '../../chat/MarkdownBlock.vue'
import { CodeEditor, Segmented, Badge, type SegmentedOption } from '../ui'

withDefaults(
  defineProps<{
    path: string
    note?: string
    readonly?: boolean
    dirty?: boolean
    placeholder?: string
  }>(),
  { note: undefined, readonly: false, dirty: false, placeholder: undefined },
)

const content = defineModel<string>({ default: '' })
const emit = defineEmits<{ save: [] }>()

type Mode = 'edit' | 'preview'
const mode = ref<Mode>('edit')
const modes: SegmentedOption<Mode>[] = [
  { value: 'edit', label: '编辑' },
  { value: 'preview', label: '预览' },
]
</script>

<template>
  <div class="memory-editor-pane">
    <div class="toolbar">
      <div class="file">
        <span class="path" :title="path">{{ path }}</span>
        <Badge v-if="readonly">只读</Badge>
        <Badge v-else-if="dirty" tone="warn">未保存</Badge>
      </div>
      <div class="controls">
        <slot name="toolbar" />
        <Segmented v-model="mode" :options="modes" aria-label="编辑或预览" />
      </div>
    </div>
    <slot />
    <CodeEditor
      v-if="mode === 'edit'"
      v-model="content"
      language="markdown"
      wrap
      fill
      :min-lines="12"
      :readonly="readonly"
      :placeholder="placeholder"
      :aria-label="path"
      @save="emit('save')"
    />
    <div v-else class="preview">
      <MarkdownBlock v-if="content.trim()" :content="content" />
      <p v-else class="empty">（空）</p>
    </div>
    <p v-if="note" class="note">{{ note }}</p>
  </div>
</template>

<style scoped>
.memory-editor-pane {
  display: flex;
  flex: 1 0 auto;
  flex-direction: column;
  gap: var(--space-2-5);
  min-width: 0;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  min-width: 0;
}

.file {
  display: flex;
  flex: 1 1 200px;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.path {
  min-width: 0;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--text-2));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.controls {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  max-width: 100%;
}

.preview {
  flex: 1 1 auto;
  min-height: calc(var(--lh-xxs) * 12);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--stroke-2);
  border-radius: var(--radius-row);
  background: rgb(var(--surface-overlay));
  overflow-wrap: anywhere;
}

.empty {
  margin: 0;
  font-size: var(--fs-xs);
  color: rgb(var(--text-3));
}

.note {
  margin: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--text-3));
}
</style>
