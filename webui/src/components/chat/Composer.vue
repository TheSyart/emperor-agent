<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import type { SlashCommand } from '../../commands'
import { actionAssets } from '../../assets'

const props = defineProps<{ busy: boolean; commands: SlashCommand[] }>()
const emit = defineEmits<{ send: [content: string] }>()
const value = ref('')
const input = ref<HTMLTextAreaElement | null>(null)

const suggestions = computed(() => {
  const text = value.value.trim().toLowerCase()
  if (!text.startsWith('/')) return []
  return props.commands
    .filter((command) => command.name.startsWith(text) || command.aliases?.some((alias) => alias.startsWith(text)))
    .slice(0, 6)
})

function resize() {
  const el = input.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 180)}px`
}

function submit() {
  const content = value.value.trim()
  if (!content || props.busy) return
  emit('send', content)
  value.value = ''
  void nextTick(resize)
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Tab' && suggestions.value.length) {
    event.preventDefault()
    value.value = suggestions.value[0].usage
    void nextTick(resize)
    return
  }
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  submit()
}

function applySuggestion(command: SlashCommand) {
  value.value = command.usage
  input.value?.focus()
  void nextTick(resize)
}
</script>

<template>
  <div class="composer-shell">
    <div v-if="suggestions.length" class="slash-menu">
      <button v-for="command in suggestions" :key="command.name" type="button" @click="applySuggestion(command)">
        <strong>{{ command.name }}</strong>
        <span>{{ command.description }}</span>
      </button>
    </div>
    <form class="composer" @submit.prevent="submit">
      <textarea
        ref="input"
        v-model="value"
        rows="1"
        :disabled="props.busy"
        :placeholder="props.busy ? 'AI 正在执行...' : '向李公公交办一件差事... 输入 / 查看命令'"
        @input="resize"
        @keydown="handleKeydown"
      />
      <button class="send-button" :disabled="props.busy || !value.trim()" type="submit">
        <img class="action-icon send-icon" :src="props.busy ? actionAssets.statusBusy : actionAssets.send" alt="" width="24" height="24" />
        <span class="sr-only">{{ props.busy ? '等待' : '发送' }}</span>
      </button>
    </form>
  </div>
</template>
