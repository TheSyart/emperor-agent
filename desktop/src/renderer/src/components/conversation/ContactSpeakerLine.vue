<script setup lang="ts">
/**
 * ContactSpeakerLine — who answers in a single chat with a contact (GRP-05):
 * the contact's avatar (20px) and name above each reply, quiet like a
 * caption, so the chat reads as talking to that colleague.
 *
 * Props: speaker ({ name, avatar } from contactChat.ts).
 */
import Avatar from '../ui/Avatar.vue'
import type { ContactSpeaker } from './contactChat'

defineProps<{ speaker: ContactSpeaker }>()
</script>

<template>
  <div class="speaker" data-contact-speaker>
    <Avatar v-bind="speaker.avatar" :size="20" />
    <span class="name">{{ speaker.name }}</span>
  </div>
</template>

<style scoped>
.speaker {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding-bottom: var(--space-2);
  color: rgb(var(--text-2));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: var(--weight-medium);
}

.name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
