<script setup lang="ts">
/**
 * First-run dialog shown while no model is configured. A modal layer
 * (ui/modalStack: Escape closes it as 稍后) with the shared focus trap:
 * focus starts on 配置模型, Tab stays inside, the app behind is inert.
 */
import { computed, ref } from 'vue'
import { useModalLayer } from '../ui/modalStack'
import { useFocusTrap } from '../ui/useFocusTrap'
import { actionIcons, navIcon } from '../../icons'
import heroUrl from '../../../../../../assets/generated/model-setup-modal-hero-v2.png'
import wordmarkUrl from '../../../../../../assets/generated/emperoragent-wordmark.png'
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

      <div class="model-setup-copy">
        <header class="model-setup-head">
          <img
            class="model-setup-wordmark"
            :src="wordmarkUrl"
            :alt="content.brandAlt"
            draggable="false"
          />
        </header>

        <div class="model-setup-intro">
          <h2 id="model-setup-title">{{ content.title }}</h2>
          <p id="model-setup-description">{{ content.subtitle }}</p>
        </div>

        <div class="model-setup-status" role="status">
          <p>{{ content.status }}</p>
        </div>

        <footer class="model-setup-actions">
          <p>{{ content.helperText }}</p>
          <div class="model-setup-action-row">
            <button class="tool-button" type="button" @click="emit('close')">
              {{ content.secondaryAction }}
            </button>
            <button
              class="tool-button ink asset-button primary-action"
              type="button"
              data-autofocus
              @click="emit('configure')"
            >
              <component :is="modelIcon" class="action-icon" :size="16" />
              <span>{{ content.primaryAction }}</span>
            </button>
          </div>
        </footer>
      </div>

      <aside
        class="model-setup-visual"
        aria-label="Emperor Agent product preview"
      >
        <img :src="heroUrl" :alt="content.heroAlt" draggable="false" />
      </aside>
    </section>
  </div>
</template>
