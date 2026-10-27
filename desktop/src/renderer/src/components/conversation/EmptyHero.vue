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
 * The first Build home (no project yet, BRD-04) shows 小单 on his throne
 * above the words instead of the mark (`scene`); it is decoration only.
 *
 * Props: mode? (default chat), addressName? (the profile's 称呼, null:
 * none), speaker? (a single chat's contact), speakerIntro?, scene?.
 */
import { computed } from 'vue'
import type { AppMode } from '../../runtime/appMode'
import throne from '../../assets/mascot/throne.webp'
import BrandMark from '../brand/BrandMark.vue'
import Avatar from '../ui/Avatar.vue'
import type { ContactSpeaker } from './contactChat'
import { contactHeroNote, heroHeadline, heroNote } from './heroGreeting'
import { courtlyHeadline } from '../../copy/courtly'
import { useUiPreferences } from '../../composables/useUiPreferences'

const props = defineProps<{
  mode?: AppMode
  addressName?: string | null
  speaker?: ContactSpeaker | null
  speakerIntro?: string
  scene?: boolean
}>()
const { preferences } = useUiPreferences()
const headline = computed(() =>
  props.speaker
    ? props.speaker.name
    : preferences.value.courtlyCopy
      ? courtlyHeadline(props.mode ?? 'chat')
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
    <div class="glow" aria-hidden="true" />
    <div v-if="scene && !speaker" class="scene" aria-hidden="true">
      <img :src="throne" alt="" draggable="false" data-hero-scene />
    </div>
    <h1 class="headline" :data-contact-hero="speaker ? '' : undefined">
      <Avatar
        v-if="speaker"
        v-bind="speaker.avatar"
        :size="40"
        labelled
        class="mark"
      />
      <BrandMark v-else-if="!scene" :size="34" class="mark" />
      <span>{{ headline }}</span>
    </h1>
    <p v-if="note" class="note">{{ note }}</p>
  </div>
</template>

<style scoped>
.scene {
  position: relative;
  display: flex;
  justify-content: center;
}

.scene img {
  height: 148px;
  width: auto;
  user-select: none;
}

/* A short window keeps the composer in view: the picture goes first. */
@media (max-height: 640px) {
  .scene {
    display: none;
  }
}

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
