<script setup lang="ts">
import type { TodoItem } from '../../types'

const props = defineProps<{ todos: TodoItem[] }>()

function marker(status: string) {
  if (status === 'completed') return '完'
  if (status === 'in_progress') return '办'
  return '候'
}
</script>

<template>
  <section class="todo-panel">
    <div class="mb-3 flex items-center justify-between">
      <h3 class="font-display text-sm font-bold text-ink">待办事项</h3>
      <span class="text-xs text-muted">{{ props.todos.length }} 项</span>
    </div>
    <div class="space-y-2">
      <div v-for="todo in props.todos" :key="todo.id" class="todo-item" :class="todo.status">
        <span class="todo-mark">{{ marker(todo.status) }}</span>
        <span class="font-mono text-[11px] text-muted">{{ todo.id }}.</span>
        <span class="min-w-0 flex-1">{{ todo.content }}</span>
      </div>
    </div>
  </section>
</template>
