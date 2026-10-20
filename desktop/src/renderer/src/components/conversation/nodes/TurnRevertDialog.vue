<script setup lang="ts">
/**
 * TurnRevertDialog — confirms undoing one recorded turn (plan 7.6): every
 * file is listed and checked, each can be unchecked; files too large to
 * have been recorded cannot be chosen. Core restores only the files that
 * still match the turn's end and skips the rest; there is no redo. A note
 * warns when another session ran in the same workspace during the turn.
 *
 * Props: sessionId, turn, files, concurrent. v-model:open.
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
import { fileStatusTag, splitFilePath } from './turnFilesModel'

const props = defineProps<{
  sessionId: string
  turn: number
  files: readonly TurnFileEntry[]
  concurrent: boolean
}>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ done: [result: TurnFilesReverted] }>()

const chosen = ref(new Set<string>())
const busy = ref(false)
const error = ref('')

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
    title="撤销这一轮的改动？"
    description="只恢复这一轮结束后没有再改过的文件，改过的会跳过并列出。撤销后不能重做。"
    :width="460"
    :close-on-mask="!busy"
    :closable="!busy"
  >
    <p v-if="concurrent" class="warning" data-turn-revert-concurrent>
      这一轮期间，同一工作区还有其他会话在运行，列表里可能有它们的改动。
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
  color: rgb(var(--label-primary));
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
  color: rgb(var(--label-tertiary));
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
  color: rgb(var(--label-tertiary));
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
