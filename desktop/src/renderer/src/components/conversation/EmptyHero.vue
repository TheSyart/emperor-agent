<script setup lang="ts">
/**
 * EmptyHero — dsh NEW SESSION hero chrome: brand mark + headline (26/32
 * medium) centered above the composer card, with the gold backdrop glow
 * centered on the card. The card itself is the shared ComposerCard rendered
 * by ConversationView in the same seat (no remount between phases).
 *
 * The words follow the mode of the session on screen (MOD-03,
 * heroGreeting.ts): Chat greets by the profile's 称呼 (UI-S17) —
 * 「安先生，今天想聊点什么？」; Build asks 「今天推进哪个项目？」 and says
 * in a line under it where its sessions run (the project itself is the gold
 * chip in the composer).
 *
 * Props: mode? (default chat), addressName? (the profile's 称呼, null: none).
 */
import { computed } from 'vue'
import type { AppMode } from '../../runtime/appMode'
import BrandMark from '../brand/BrandMark.vue'
import { heroHeadline, heroNote } from './heroGreeting'

const props = defineProps<{
  mode?: AppMode
  addressName?: string | null
}>()
const headline = computed(() =>
  heroHeadline(props.addressName, props.mode ?? 'chat'),
)
const note = computed(() => heroNote(props.mode ?? 'chat'))
</script>

<template>
  <div class="empty-hero">
    <div class="glow" aria-hidden="true" />
    <h1 class="headline">
      <BrandMark :size="34" class="mark" />
      <span>{{ headline }}</span>
    </h1>
    <p v-if="note" class="note">{{ note }}</p>
  </div>
</template>

<style scoped>
.empty-hero {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-1);
}

.headline {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2-5);
  margin: 0;
  color: rgb(var(--text-1));
  font-size: 26px;
  line-height: var(--space-8);
  font-weight: var(--weight-medium);
  letter-spacing: 0.01em;
}

.mark {
  flex: none;
}

.note {
  position: relative;
  margin: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--text-3));
  text-align: center;
}

.glow {
  position: absolute;
  top: 100%;
  left: 50%;
  width: min(1060px, 135vw);
  aspect-ratio: 1051 / 468;
  background: radial-gradient(
    closest-side,
    rgb(var(--accent) / 0.16),
    rgb(var(--accent) / 0.06) 55%,
    transparent
  );
  transform: translate(-50%, -30%);
  pointer-events: none;
}
</style>
