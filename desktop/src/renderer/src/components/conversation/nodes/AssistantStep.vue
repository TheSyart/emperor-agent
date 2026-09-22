<script setup lang="ts">
/**
 * AssistantStep — one model step (dsh AssistantMarkdown): blocks in order —
 * markdown text (16/28), reasoning as the Think row, consecutive images as
 * one gallery; tool-call heads render as their own tool rows. An
 * interrupted step ends with a quiet "已停止" tag. Settled text-only steps
 * that are not followed by their turn tail get a hover copy action.
 *
 * Props: node (assistant), closing (the turn tail follows this row).
 */
import { computed } from 'vue'
import { attachmentRawUrl } from '../../../api/attachments'
import type {
  AssistantBlock,
  AssistantChatNode,
} from '../../../conversation/types'
import JsonTree from '../../ui/JsonTree.vue'
import ConversationMarkdown from '../parts/ConversationMarkdown.vue'
import MessageIconActions from '../parts/MessageIconActions.vue'
import ReasoningRow from './ReasoningRow.vue'

const props = withDefaults(
  defineProps<{ node: AssistantChatNode; closing?: boolean }>(),
  { closing: false },
)

type Rendered =
  | { kind: 'text'; key: string; text: string; last: boolean }
  | { kind: 'reasoning'; key: string; text: string; last: boolean }
  | {
      kind: 'images'
      key: string
      images: Extract<AssistantBlock, { kind: 'image' }>['attachment'][]
    }
  | { kind: 'other'; key: string; block: unknown }

const streaming = computed(() => props.node.data.status === 'running')

const rendered = computed<Rendered[]>(() => {
  const blocks = props.node.data.blocks
  const out: Rendered[] = []
  const lastIndex = blocks.length - 1
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]
    if (block === undefined) continue
    switch (block.kind) {
      case 'text':
        if (block.text.trim() !== '' || index === lastIndex)
          out.push({
            kind: 'text',
            key: `t${index}`,
            text: block.text,
            last: index === lastIndex,
          })
        break
      case 'reasoning':
        if (block.text.trim() !== '' || index === lastIndex)
          out.push({
            kind: 'reasoning',
            key: `r${index}`,
            text: block.text,
            last: index === lastIndex,
          })
        break
      case 'image': {
        const start = index
        const images = [block.attachment]
        while (blocks[index + 1]?.kind === 'image') {
          index++
          const next = blocks[index]
          if (next?.kind === 'image') images.push(next.attachment)
        }
        out.push({ kind: 'images', key: `i${start}`, images })
        break
      }
      case 'tool-call':
        break
      default:
        out.push({ kind: 'other', key: `o${index}`, block: block.block })
    }
  }
  return out
})

const interrupted = computed(() => props.node.data.status === 'interrupted')
const visible = computed(
  () => rendered.value.length > 0 || streaming.value || interrupted.value,
)
const plainText = computed(() =>
  props.node.data.blocks
    .flatMap((block) => (block.kind === 'text' ? [block.text] : []))
    .join('\n\n')
    .trim(),
)
const showActions = computed(
  () =>
    !streaming.value &&
    !props.closing &&
    plainText.value !== '' &&
    !props.node.data.blocks.some((block) => block.kind === 'tool-call'),
)
</script>

<template>
  <div
    v-if="visible"
    class="assistant-step"
    :data-streaming="streaming || undefined"
    data-time-hover-root
  >
    <div class="body">
      <template v-for="item in rendered" :key="item.key">
        <ConversationMarkdown
          v-if="item.kind === 'text'"
          :text="item.text"
          :streaming="streaming && item.last"
        />
        <ReasoningRow
          v-else-if="item.kind === 'reasoning'"
          :text="item.text"
          :running="streaming && item.last"
          :expansion-key="`${node.key}:${item.key}`"
        />
        <div v-else-if="item.kind === 'images'" class="images">
          <img
            v-for="image in item.images"
            :key="image.attachmentId"
            class="image"
            :src="attachmentRawUrl(image.attachmentId)"
            alt=""
            loading="lazy"
          />
        </div>
        <div v-else class="other">
          <JsonTree :value="item.block" />
        </div>
      </template>
      <span v-if="interrupted" class="stopped">已停止</span>
    </div>
    <MessageIconActions
      v-if="showActions"
      class="actions"
      :text="plainText"
      :time="node.data.time"
      clock="end"
    />
  </div>
</template>

<style scoped>
.assistant-step {
  display: flex;
  flex-direction: column;
  min-width: 0;
  font: var(--font-md);
  color: rgb(var(--label-primary));
}

.body {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}

.images {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.image {
  max-width: min(360px, 100%);
  max-height: 280px;
  border-radius: var(--radius-row);
  border: 1px solid var(--border-l1);
  object-fit: cover;
}

.other {
  padding: var(--space-2);
  border-radius: var(--radius-row);
  background: rgb(var(--code-block-bg));
  font: var(--font-code-small);
}

.stopped {
  align-self: flex-start;
  padding: 0 var(--space-1-5);
  border-radius: var(--radius-sm);
  background: var(--interactive-bg-hover);
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxs);
}

.actions {
  margin-top: var(--space-2);
  margin-left: calc(0px - var(--space-1-5));
  opacity: 0;
  transition: opacity var(--duration-instant) ease;
}

.assistant-step:hover .actions,
.assistant-step:focus-within .actions {
  opacity: 1;
}
</style>
