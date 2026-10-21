<script setup lang="ts">
/**
 * TurnRevertDialog — confirms undoing one recorded task (plan 7.6, UI-S15;
 * one turn in older logs): every file is listed and checked, each can be
 * unchecked; files too large to have been recorded cannot be chosen. Core
 * restores only the files that still match the task's end and skips the
 * rest, in one pass over the task's snapshots; there is no redo. A note
 * warns when another session ran in the same workspace during the task.
 *
 * Props: sessionId, turn (the record's), files, concurrent, scope (what the
 * record covers, for the words). v-model:open.
 * Emits: done (the Core result; the card updates from the session log).
 */
import { computed, ref, watch } from 'vue'
import type {
  TurnFileEntry,
  TurnFilesReverted,
} from '@emperor/core/runtime-contract'
import { core } from '../../../api/http'
import Badge from '../../ui/Badge.vue'
import Button from '../../ui/Button.vue'
import Checkbox from '../../ui/Checkbox.vue'
import Modal from '../../ui/Modal.vue'
import {
  fileStatusTag,
  splitFilePath,
  turnRevertCopy,
  type TurnFilesScope,
} from './turnFilesModel'

const props = withDefaults(
  defineProps<{
    sessionId: string
    turn: number
    files: readonly TurnFileEntry[]
    concurrent: boolean
    scope?: TurnFilesScope
  }>(),
  { scope: 'turn' },
)
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ done: [result: TurnFilesReverted] }>()

const chosen = ref(new Set<string>())
const busy = ref(false)
const error = ref('')

const copy = computed(() => turnRevertCopy(props.scope))
const choosable = computed(() => props.files.filter((file) => !file.tooLarge))
const count = computed(() => chosen.value.size)

watch(open, (value) => {
  if (!value) return
  chosen.value = new Set(choosable.value.map((file) => file.path))
  error.value = ''
})

function toggle(path: string, checked: boolean): void {
  const next = new Set(chosen.value)
  if (checked) next.add(path)
  else next.delete(path)
  chosen.value = next
}

async function confirm(): Promise<void> {
  if (busy.value || count.value === 0) return
  busy.value = true
  error.value = ''
  try {
    const result = await core('workspace.revertTurn', {
      sessionId: props.sessionId,
      turn: props.turn,
      paths: props.files
        .map((file) => file.path)
        .filter((path) => chosen.value.has(path)),
    })
    emit('done', result)
    open.value = false
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal
    v-model:open="open"
    :title="copy.title"
    :description="copy.description"
    :width="460"
    :close-on-mask="!busy"
    :closable="!busy"
  >
    <p v-if="concurrent" class="warning" data-turn-revert-concurrent>
      {{ copy.concurrent }}
    </p>
    <ul class="files" aria-label="要撤销的文件">
      <li v-for="file in files" :key="file.path">
        <Checkbox
          class="file"
          :class="{ disabled: file.tooLarge }"
          :model-value="chosen.has(file.path)"
          :disabled="file.tooLarge || busy"
          @update:model-value="toggle(file.path, $event)"
        >
          <span class="path" :title="file.path">
            <span class="dir">{{ splitFilePath(file.path).dir }}</span>
            <span class="name">{{ splitFilePath(file.path).name }}</span>
          </span>
          <Badge v-if="file.tooLarge" tone="warn">过大，无法撤销</Badge>
          <Badge v-else-if="fileStatusTag(file)">
            {{ fileStatusTag(file) }}
          </Badge>
        </Checkbox>
      </li>
    </ul>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <template #footer>
      <Button variant="secondary" :disabled="busy" @click="open = false">
        取消
      </Button>
      <Button
        variant="danger"
        :disabled="busy || count === 0"
        data-action="confirm"
        @click="confirm"
      >
        {{ busy ? '正在撤销…' : `撤销 ${count} 个文件` }}
      </Button>
    </template>
  </Modal>
</template>

<style scoped>
.warning {
  margin: 0 0 var(--space-2);
  padding: var(--space-2) var(--space-2-5);
  border-radius: var(--radius-row);
  background: rgb(var(--warn) / 0.12);
  color: rgb(var(--text-1));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.files {
  max-height: 260px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.file {
  display: flex;
  padding: var(--space-1) 0;
}

.file :deep(.label) {
  display: flex;
  flex: 1;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.file.disabled {
  color: rgb(var(--text-3));
}

.path {
  display: flex;
  min-width: 0;
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
}

.dir {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: rgb(var(--text-3));
}

.name {
  flex: none;
}

.error {
  margin: var(--space-2) 0 0;
  color: rgb(var(--error));
  font-size: var(--fs-xs);
}
</style>
