<script setup lang="ts">
/**
 * First-run dialog shown while no model is configured. A modal layer
 * (ui/modalStack: Escape closes it as 稍后) with the shared focus trap:
 * focus starts on 配置模型, Tab stays inside, the app behind is inert.
 * UI-S12: the illustration fills the dialog (its left 40% is left empty
 * for the copy) and follows the resolved theme; the brand line is the
 * vector mark plus the name, not a bitmap wordmark.
 */
import { computed, ref } from 'vue'
import BrandMark from '../brand/BrandMark.vue'
import { useModalLayer } from '../ui/modalStack'
import { useFocusTrap } from '../ui/useFocusTrap'
import { useTheme } from '../../composables/useTheme'
import { actionIcons, navIcon } from '../../icons'
import heroDarkUrl from '../../../../../../assets/generated/model-setup-hero-dark.webp'
import heroLightUrl from '../../../../../../assets/generated/model-setup-hero-light.webp'
import { buildModelSetupDialogContent } from './modelSetupDialogModel'

const props = defineProps<{
  open: boolean
  message: string
}>()

const emit = defineEmits<{
  close: []
  configure: []
}>()

const content = computed(() => buildModelSetupDialogContent(props.message))
const backdrop = ref<HTMLElement | null>(null)
const dialog = ref<HTMLElement | null>(null)
const open = computed(() => props.open)
useModalLayer(open, () => emit('close'))
useFocusTrap(dialog, open, { layer: () => backdrop.value })
const { theme } = useTheme()
const heroUrl = computed(() =>
  theme.value === 'light' ? heroLightUrl : heroDarkUrl,
)
const modelIcon = navIcon('model')
const closeIcon = actionIcons.close
</script>

<template>
  <div
    v-if="open"
    ref="backdrop"
    class="onboarding-backdrop model-setup-backdrop"
    role="presentation"
  >
    <section
      ref="dialog"
      class="model-setup-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="model-setup-title"
      aria-describedby="model-setup-description"
    >
      <button
        class="model-setup-close"
        type="button"
        title="关闭"
        aria-label="关闭"
        data-dismiss
        @click="emit('close')"
      >
        <component :is="closeIcon" :size="16" />
      </button>

      <img
        class="model-setup-art"
        :src="heroUrl"
        :alt="content.heroAlt"
        draggable="false"
      />

      <div class="model-setup-copy">
        <header class="model-setup-head">
          <BrandMark :size="26" />
          <span class="model-setup-wordmark">{{ content.brand }}</span>
        </header>

        <div class="model-setup-intro">
          <h2 id="model-setup-title">{{ content.title }}</h2>
          <p id="model-setup-description">{{ content.subtitle }}</p>
        </div>

        <div class="model-setup-status" role="status">
          <p>{{ content.status }}</p>
        </div>

        <footer class="model-setup-actions">
          <div class="model-setup-action-row">
            <button
              class="model-setup-button primary"
              type="button"
              data-autofocus
              @click="emit('configure')"
            >
              <component :is="modelIcon" :size="16" />
              <span>{{ content.primaryAction }}</span>
            </button>
            <button
              class="model-setup-button"
              type="button"
              @click="emit('close')"
            >
              {{ content.secondaryAction }}
            </button>
          </div>
          <p>{{ content.helperText }}</p>
        </footer>
      </div>
    </section>
  </div>
</template>
