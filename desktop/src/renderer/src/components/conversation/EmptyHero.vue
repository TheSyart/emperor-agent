<script setup lang="ts">
/**
 * EmptyHero — dsh NEW SESSION hero chrome: brand mark + headline (26/32
 * medium) centered above the composer card, with the gold backdrop glow
 * centered on the card. The card itself is the shared ComposerCard rendered
 * by ConversationView in the same seat (no remount between phases).
 */
import BrandMark from '../brand/BrandMark.vue'

defineProps<{ projectName?: string }>()
</script>

<template>
  <div class="empty-hero">
    <div class="glow" aria-hidden="true" />
    <h1 class="headline">
      <BrandMark :size="34" class="mark" />
      <span>今天想推进什么？</span>
    </h1>
    <p v-if="projectName" class="project">
      项目 · <strong>{{ projectName }}</strong>
    </p>
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
  color: rgb(var(--label-primary));
  font-size: 26px;
  line-height: var(--space-8);
  font-weight: 500;
  letter-spacing: 0.01em;
}

.mark {
  flex: none;
}

.project {
  position: relative;
  margin: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-tertiary));
}

.project strong {
  color: rgb(var(--label-secondary));
  font-weight: 500;
}

.glow {
  position: absolute;
  top: 100%;
  left: 50%;
  width: min(1060px, 135vw);
  aspect-ratio: 1051 / 468;
  background: radial-gradient(
    closest-side,
    rgb(var(--accent-fill) / 0.16),
    rgb(var(--accent-fill) / 0.06) 55%,
    transparent
  );
  transform: translate(-50%, -30%);
  pointer-events: none;
}
</style>
