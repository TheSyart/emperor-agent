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
 * A single chat with a contact (GRP-05) greets as the contact instead: its
 * avatar and name, and its intro under them.
 *
 * A skin may put a picture above the greeting (BRD-05 `hero` slot; not in
 * a single chat) and pick the headline's font (`--font-heading`).
 *
 * Props: mode? (default chat), addressName? (the profile's 称呼, null:
 * none), speaker? (a single chat's contact), speakerIntro?.
 */
import { computed } from 'vue'
import type { AppMode } from '../../runtime/appMode'
import SkinSlot from '../../skin/SkinSlot.vue'
import BrandMark from '../brand/BrandMark.vue'
import Avatar from '../ui/Avatar.vue'
import type { ContactSpeaker } from './contactChat'
import { contactHeroNote, heroHeadline, heroNote } from './heroGreeting'

const props = defineProps<{
  mode?: AppMode
  addressName?: string | null
  speaker?: ContactSpeaker | null
  speakerIntro?: string
}>()
const headline = computed(() =>
  props.speaker
    ? props.speaker.name
    : heroHeadline(props.addressName, props.mode ?? 'chat'),
)
const note = computed(() =>
  props.speaker
    ? contactHeroNote(props.speakerIntro ?? '')
    : heroNote(props.mode ?? 'chat'),
)
</script>

<template>
  <div class="empty-hero">
    <SkinSlot v-if="!speaker" name="hero" class="skin-hero" />
    <div class="glow" aria-hidden="true" />
    <h1 class="headline" :data-contact-hero="speaker ? '' : undefined">
      <Avatar
        v-if="speaker"
        v-bind="speaker.avatar"
        :size="40"
        labelled
        class="mark"
      />
      <BrandMark v-else :size="34" class="mark" />
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
  font-family: var(--font-heading);
  font-size: 26px;
  line-height: var(--space-8);
  font-weight: var(--weight-medium);
  letter-spacing: 0.01em;
}

.mark {
  flex: none;
}

.skin-hero {
  position: relative;
  max-width: 100%;
  height: calc(var(--space-8) * 4);
  margin-bottom: var(--space-1);
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
