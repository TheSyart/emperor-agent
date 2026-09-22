<script setup lang="ts">
/**
 * Settings › 桌宠 — the optional Clawd desktop companion: a preview stage
 * (click a sprite to preview it), the enable Switch row (opens / closes the
 * pet window through ctx.setDesktopPetEnabled), the start-up mode and the
 * last window error, then the grid of the 14 runtime-state sprites. Sprite
 * URLs come from pet/petSprites.ts (import.meta.glob) so they resolve in the
 * packaged app too.
 */
import { computed, ref } from 'vue'
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  StatusBadge,
  Switch,
} from './ui'
import { useAppContext } from '../../composables/useAppContext'
import { PET_IDLE_SPRITE_ID, PET_SPRITES } from './pet/petSprites'

const ctx = useAppContext()
const busy = ref(false)
const previewId = ref(PET_IDLE_SPRITE_ID)

const pet = computed(() => ctx.boot.value?.desktopPet)
const enabled = computed(() => Boolean(pet.value?.enabled))
const preview = computed(
  () =>
    PET_SPRITES.find((sprite) => sprite.id === previewId.value) ??
    PET_SPRITES[0],
)

const status = computed(() => {
  if (pet.value?.lastError) return { tone: 'error' as const, text: '异常' }
  if (pet.value?.running) return { tone: 'ok' as const, text: '运行中' }
  if (pet.value?.enabled) return { tone: 'warn' as const, text: '待启动' }
  return { tone: 'neutral' as const, text: '已关闭' }
})

const switchDescription = computed(() => {
  if (busy.value) return enabled.value ? '正在关闭桌宠…' : '正在启动桌宠…'
  if (pet.value?.running)
    return pet.value.pid ? `运行中 · PID ${pet.value.pid}` : '运行中'
  return enabled.value ? '已开启，等待桌宠窗口启动' : '在桌面显示 Clawd'
})

function setEnabled(next: boolean) {
  if (busy.value || next === enabled.value) return
  busy.value = true
  void ctx
    .runSafely(async () => {
      await ctx.setDesktopPetEnabled(next)
    })
    .finally(() => {
      busy.value = false
    })
}
</script>

<template>
  <SettingsSection>
    <div class="pet-hero">
      <div class="stage" data-testid="pet-preview">
        <img
          v-if="preview"
          :key="preview.id"
          :src="preview.url"
          :alt="`Clawd ${preview.label}`"
          class="stage-img"
        />
      </div>
      <div class="hero-text">
        <div class="hero-title">
          <span class="name">Clawd</span>
          <StatusBadge :tone="status.tone" dot data-testid="pet-status">
            {{ status.text }}
          </StatusBadge>
        </div>
        <p class="hero-description">
          Electron 桌面伴侣：跟随 Agent
          的运行事件切换动画、显示聊天气泡，空闲时进入待机场景。
        </p>
        <p v-if="preview" class="hero-caption">预览：{{ preview.label }}</p>
      </div>
    </div>

    <SettingsRow
      title="启用桌宠"
      :description="switchDescription"
      label-for="pet-enabled"
    >
      <Switch
        id="pet-enabled"
        :model-value="enabled"
        :disabled="busy"
        @update:model-value="setEnabled"
      />
    </SettingsRow>
    <SettingsRow title="启动方式" description="桌宠窗口随应用启动的方式">
      <span class="value">
        {{ pet?.autoStartWithWebui ? '跟随 WebUI 自动启动' : '手动控制' }}
      </span>
    </SettingsRow>
    <SettingsRow v-if="pet?.lastError" title="最近错误">
      <template #description>
        <span class="error-text">{{ pet.lastError }}</span>
      </template>
    </SettingsRow>

    <SettingsGroup
      title="动画精灵"
      :description="`${PET_SPRITES.length} 种绑定到运行时事件的 SVG 动画状态，点选即可预览`"
    >
      <div class="sprite-grid" role="group" aria-label="动画精灵">
        <button
          v-for="sprite in PET_SPRITES"
          :key="sprite.id"
          type="button"
          class="sprite"
          :class="{ selected: sprite.id === previewId }"
          :aria-pressed="sprite.id === previewId"
          :data-sprite="sprite.id"
          @click="previewId = sprite.id"
        >
          <img :src="sprite.url" alt="" class="sprite-img" />
          <span class="sprite-label">{{ sprite.label }}</span>
        </button>
      </div>
    </SettingsGroup>
  </SettingsSection>
</template>

<style scoped>
/* Preview stage + identity, dsh hero-card proportions. */
.pet-hero {
  display: flex;
  align-items: center;
  gap: var(--space-5);
  min-width: 0;
  padding: var(--space-4) 0;
  border-bottom: 1px solid var(--border-l2);
}

.stage {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 144px;
  height: 144px;
  overflow: hidden;
  border-radius: var(--radius-card);
  background: rgb(var(--code-block-bg));
}

/* The Clawd SVGs keep wide margins for bubbles / props: show them full
   bleed so the character reads at a useful size. */
.stage-img {
  width: 144px;
  height: 144px;
  object-fit: contain;
}

.hero-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.hero-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.name {
  font-size: var(--fs-md);
  line-height: var(--lh-md);
  font-weight: 600;
  color: rgb(var(--label-primary));
}

.hero-description {
  margin: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-secondary));
  text-wrap: pretty;
}

.hero-caption {
  margin: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
}

.value {
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-secondary));
  white-space: nowrap;
}

.error-text {
  color: rgb(var(--state-error-label));
  overflow-wrap: anywhere;
}

.sprite-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: var(--space-2);
  padding-top: var(--space-3);
}

.sprite {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1-5);
  min-width: 0;
  padding: var(--space-2) var(--space-2) var(--space-2-5);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-card);
  background: transparent;
  font: inherit;
  color: rgb(var(--label-secondary));
  cursor: pointer;
  transition:
    background-color var(--duration-ds-fast) ease,
    border-color var(--duration-ds-fast) ease;
}

.sprite:hover:not(.selected) {
  background: var(--interactive-bg-hover);
}

.sprite.selected {
  border-color: rgb(var(--nb-400));
  background: rgb(var(--selector-fill));
  color: rgb(var(--label-primary));
}

.sprite:focus-visible {
  outline: 2px solid rgb(var(--focus-ring));
  outline-offset: 2px;
}

.sprite-img {
  width: 64px;
  height: 64px;
  object-fit: contain;
}

.sprite-label {
  max-width: 100%;
  overflow: hidden;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Narrow section: the stage sits above the text. */
@container (max-width: 439px) {
  .pet-hero {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
