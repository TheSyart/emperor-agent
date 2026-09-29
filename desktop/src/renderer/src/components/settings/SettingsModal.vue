<script setup lang="ts">
/**
 * SettingsModal — dsh settings panel (800 × min(800, 100vh−48), r24,
 * layer-2, lv3) over a blurred mask. Open state and the active section are
 * the route query (`?settings=<section>`, see useSettingsRoute), so the
 * conversation underneath keeps its session and scroll.
 *
 * Mounted once in App.vue as `<SettingsModal />` (no props). Close paths:
 * the header close button, a mask click and Escape. Escape goes through the
 * shared modal stack (ui/modalStack.ts), so a dialog opened on top of the
 * panel (ui/Modal) closes first and alone. Focus moves to the panel on open
 * and returns to the previously focused element on close.
 *
 * Layout: 188px nav rail + content column. The content column is a 54px
 * header (section title, the section's header actions, close) over the
 * options area (padding 0 24 24, content ≤ 720px, scrolls vertically).
 * 定时任务 / 插件 / Skills / MCP are full pages now (/scheduler,
 * /capabilities/:tab); a `?settings=` link to one of them is redirected there by
 * the router guard before the modal would open.
 *
 * Section bodies are async chunks (`<Name>Section.vue`), each owning its
 * layout: they build on components/settings/ui (SettingsSection & co.) and
 * publish header actions through useSettingsHeader — the shell never styles
 * section internals. The panel is an `inline-size` container
 * (`settings-panel`): below 640px the nav rail folds into a top strip.
 */
import {
  computed,
  defineAsyncComponent,
  nextTick,
  ref,
  watch,
  type Component,
} from 'vue'
import { DsClose } from '../icons/ds'
import { useModalLayer } from '../ui/modalStack'
import SettingsHeaderBar from './SettingsHeaderBar.vue'
import SettingsNav from './SettingsNav.vue'
import { provideSettingsHeader } from './settingsHeader'
import {
  SETTINGS_SECTIONS,
  type SettingsModalSection,
} from './settingsSections'
import { useSettingsRoute } from './useSettingsRoute'

const SECTION_BODIES: Record<SettingsModalSection, Component> = {
  general: defineAsyncComponent(() => import('./GeneralSection.vue')),
  model: defineAsyncComponent(() => import('./ModelSection.vue')),
  hooks: defineAsyncComponent(() => import('./HooksSection.vue')),
  computer: defineAsyncComponent(() => import('./ComputerUseSection.vue')),
  memory: defineAsyncComponent(() => import('./MemorySection.vue')),
  tokens: defineAsyncComponent(() => import('./TokensSection.vue')),
  pet: defineAsyncComponent(() => import('./PetSection.vue')),
  diagnostics: defineAsyncComponent(() => import('./DiagnosticsSection.vue')),
}

const settings = useSettingsRoute()
const { open, section } = settings
const header = provideSettingsHeader()

const titleId = 'settings-modal-title'
const sectionTitleId = 'settings-section-title'
const panel = ref<HTMLElement | null>(null)
let restoreFocus: HTMLElement | null = null

const body = computed(() => SECTION_BODIES[section.value])
const sectionLabel = computed(
  () =>
    SETTINGS_SECTIONS.find((item) => item.key === section.value)?.label ?? '',
)

function close() {
  void settings.closeSettings()
}

function select(target: SettingsModalSection) {
  if (target === section.value) return
  void settings.selectSection(target)
}

useModalLayer(open, close)

watch(
  open,
  (value, previous) => {
    if (typeof document === 'undefined') return
    if (value) {
      if (!previous) {
        const active = document.activeElement
        restoreFocus = active instanceof HTMLElement ? active : null
      }
      void nextTick(() => panel.value?.focus({ preventScroll: true }))
    } else {
      const target = restoreFocus
      restoreFocus = null
      if (target?.isConnected) target.focus({ preventScroll: true })
    }
  },
  { immediate: true },
)
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="settings-overlay" role="presentation">
      <div class="settings-mask" aria-hidden="true" @click="close" />
      <div
        ref="panel"
        class="settings-panel ds-fade-in"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
        data-testid="settings-modal"
      >
        <div class="settings-layout">
          <SettingsNav :active="section" :title-id="titleId" @select="select" />
          <div class="settings-content">
            <div class="settings-header">
              <h2 :id="sectionTitleId" class="section-title">
                {{ sectionLabel }}
              </h2>
              <div class="header-actions">
                <SettingsHeaderBar :actions="header.actions.value" />
                <button
                  type="button"
                  class="settings-close"
                  aria-label="关闭设置"
                  title="关闭"
                  @click="close"
                >
                  <DsClose :size="14" />
                </button>
              </div>
            </div>
            <div
              class="settings-options"
              role="region"
              :aria-labelledby="sectionTitleId"
              :data-section="section"
            >
              <component :is="body" :key="section" />
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.settings-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
}

.settings-mask {
  position: absolute;
  inset: 0;
  background: var(--mask-1);
  backdrop-filter: blur(var(--mask-blur));
}

.settings-panel {
  container: settings-panel / inline-size;
  position: relative;
  width: 800px;
  height: min(800px, calc(100vh - 48px));
  max-width: calc(100vw - 48px);
  overflow: hidden;
  border-radius: var(--radius-modal);
  background: rgb(var(--bg-layer-2));
  box-shadow: var(--shadow-lv3);
  color: rgb(var(--label-primary));
  outline: none;
}

.settings-layout {
  display: flex;
  width: 100%;
  height: 100%;
}

.settings-content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* dsh .Header: h54, pad (20,14,8,10); title inset to the 24px content edge. */
.settings-header {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  height: 54px;
  padding: var(--space-5) var(--space-3-5) var(--space-2) var(--space-2-5);
  box-sizing: border-box;
}

.section-title {
  min-width: 0;
  margin: 0;
  padding-left: var(--space-3-5);
  overflow: hidden;
  font-size: var(--fs-base);
  line-height: var(--lh-base);
  font-weight: 500;
  color: rgb(var(--label-primary));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  margin-left: auto;
}

/* dsh .close: 28×28 round, 14px glyph. */
.settings-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: var(--space-7);
  height: var(--space-7);
  padding: 0;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: rgb(var(--label-primary));
  cursor: pointer;
}

.settings-close:hover {
  background: var(--interactive-bg-hover);
}

.settings-close:focus-visible {
  outline: 2px solid rgb(var(--focus-ring));
  outline-offset: 2px;
}

/* dsh .options: pad (0,24,24), scrolls. The right padding widens past 24px
   once the column exceeds 720 + 48px, capping the content at 720px while
   the scrollbar stays at the panel edge. */
.settings-options {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 0 max(var(--space-6), calc(100% - 720px - var(--space-6)))
    var(--space-6) var(--space-6);
  overflow-y: auto;
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  color: rgb(var(--label-primary));
}

@container settings-panel (max-width: 639px) {
  .settings-layout {
    flex-direction: column;
  }

  .settings-header {
    height: auto;
    padding-top: var(--space-2);
  }

  .settings-options {
    padding: 0 var(--space-4) var(--space-4);
  }

  .section-title {
    padding-left: var(--space-1-5);
  }
}
</style>
