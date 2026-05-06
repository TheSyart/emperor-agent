<script setup lang="ts">
import { useAppContext } from '../composables/useAppContext'
import Composer from '../components/chat/Composer.vue'
import MessageList from '../components/chat/MessageList.vue'
import PendingBar from '../components/chat/PendingBar.vue'

const ctx = useAppContext()
</script>

<template>
  <section class="main-view chat-view">
    <header class="view-head">
      <div class="min-w-0">
        <h1>御前对话</h1>
        <p class="truncate">{{ ctx.boot.value?.app || 'Emperor Agent' }} · WebSocket streaming runtime</p>
      </div>
    </header>

    <div class="chat-body">
      <MessageList :messages="ctx.messages.value" />
      <PendingBar :pending="ctx.pending" />
    </div>

    <div class="composer-wrap">
      <Composer :busy="ctx.busy.value" :commands="ctx.commands" @send="ctx.submitFromComposer($event)" />
    </div>
  </section>
</template>
