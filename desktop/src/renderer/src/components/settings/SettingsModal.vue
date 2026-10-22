<script setup lang="ts">
/**
 * SettingsModal — the settings panel (UI-S07: 880 × min(720, 100vh − 80),
 * r-xl, lv3) over a blurred mask: the nav on the canvas color, the page on
 * the base panel. Open state and the active section are
 * the route query (`?settings=<section>`, see useSettingsRoute), so the
 * conversation underneath keeps its session and scroll.
 *
 * Mounted once in App.vue as `<SettingsModal />` (no props). Close paths:
 * the header close button, a mask click and Escape. Escape goes through the
 * shared modal stack (ui/modalStack.ts), so a dialog opened on top of the
 * panel (ui/Modal) closes first and alone. Focus (ui/useFocusTrap) moves to
 * the panel on open, Tab stays inside it, the app behind is inert, and
 * closing returns focus to the previously focused element.
 *
 * Layout: 200px nav (four groups, SettingsNav; 子智能体 carries a dot while
 * Claude Code or Codex has a new version, AGT-13) + content column. The
 * content column is a 54px header (16/600 section title, the section's
 * header actions, close) over the options area (padding 0 24 24, content ≤
 * 720px, scrolls vertically).
 * 定时任务 / 插件 / Skills / MCP are full pages now (/scheduler,
 * /capabilities/:tab); a `?settings=` link to one of them is redirected there by
 * the router guard before the modal would open.
 *
 * On a section's sub page (`&page=<key>`, see useSettingsPages) the title
 * becomes 「分区 › 页面」: the section name is a button back to the main
 * page, as is the section's own nav cell. The options area scrolls back to
 * the top on every page change. Focus follows the user: opened from inside
 * the section (its 管理 button goes away), it moves to that button; left by
 * that button, it returns to the panel. A deep link leaves it alone.
 *
 * Unsaved edits (ui/useDirtyGuard): editors inside register with the
 * guard this shell provides. Any navigation that would change the open
 * section or sub page — close (button, mask, Escape), another nav cell, the
 * breadcrumb, a link — asks 「放弃未保存的修改？」 first and stays put on
 * 继续编辑 (a router guard, so every path is covered).
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
  onBeforeUnmount,
  ref,
  watch,
  type Component,
} from 'vue'
import { useRouter, type LocationQuery } from 'vue-router'
import { DsChevronRight, DsClose } from '../icons/ds'
import IconButton from '../ui/IconButton.vue'
import { useModalLayer } from '../ui/modalStack'
import { provideDirtyGuard } from '../ui/useDirtyGuard'
import { useFocusTrap } from '../ui/useFocusTrap'
import SettingsHeaderBar from './SettingsHeaderBar.vue'
import SettingsNav from './SettingsNav.vue'
import { useExecutorUpgrades } from './executors/executorUpgrades'
import { provideSettingsHeader } from './settingsHeader'
import {
  SETTINGS_SECTIONS,
  modalSettingsSection,
  settingsAlias,
  type SettingsModalSection,
} from './settingsSections'
import { settingsPageKey, useSettingsRoute } from './useSettingsRoute'

const SECTION_BODIES: Record<SettingsModalSection, Component> = {
  general: defineAsyncComponent(() => import('./GeneralSection.vue')),
  model: defineAsyncComponent(() => import('./ModelSection.vue')),
  executors: defineAsyncComponent(() => import('./ExecutorsSection.vue')),
  memory: defineAsyncComponent(() => import('./MemorySection.vue')),
  computer: defineAsyncComponent(() => import('./ComputerUseSection.vue')),
  browser: defineAsyncComponent(() => import('./BrowserSettingsSection.vue')),
  voice: defineAsyncComponent(() => import('./VoiceSettingsSection.vue')),
  tokens: defineAsyncComponent(() => import('./TokensSection.vue')),
  advanced: defineAsyncComponent(() => import('./AdvancedSection.vue')),
}

/** What the modal shows for a query: '' closed, else section/page. */
function settingsView(query: LocationQuery): string {
  if (query.settings == null) return ''
  const page =
    settingsPageKey(query.page) ?? settingsAlias(query.settings)?.page ?? ''
  return `${modalSettingsSection(query.settings)}/${page}`
}

const settings = useSettingsRoute()
const { open, section } = settings
// The dot on 子智能体: a new Claude Code or Codex version, or a failed
// upgrade (AGT-13). Read when the settings open; 子智能体 asks npm itself.
const upgrades = useExecutorUpgrades()
watch(
  open,
  (isOpen) => {
    if (isOpen) void upgrades.load()
  },
  { immediate: true },
)
const header = provideSettingsHeader({
  page: () => settings.page.value,
  go: (page) => void settings.openPage(page),
})

const titleId = 'settings-modal-title'
const sectionTitleId = 'settings-section-title'
const overlay = ref<HTMLElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const options = ref<HTMLElement | null>(null)
const crumb = ref<HTMLButtonElement | null>(null)

const body = computed(() => SECTION_BODIES[section.value])
const sectionLabel = computed(
  () =>
    SETTINGS_SECTIONS.find((item) => item.key === section.value)?.label ?? '',
)

function close() {
  void settings.closeSettings()
}

function select(target: SettingsModalSection) {
  if (target === section.value) {
    if (header.page.value !== null) header.back()
    return
  }
  void settings.selectSection(target)
}

const guard = provideDirtyGuard()
const removeGuard = useRouter().beforeEach((to, from) =>
  !guard.dirty.value || settingsView(to.query) === settingsView(from.query)
    ? true
    : guard.confirmDiscard(),
)
onBeforeUnmount(removeGuard)

useModalLayer(open, close)
useFocusTrap(panel, open, {
  initialFocus: () => panel.value,
  layer: () => overlay.value,
})

watch(
  () => header.page.value,
  (next) => {
    if (options.value) options.value.scrollTop = 0
    // Read before the page re-renders and the focused control is gone.
    const active =
      typeof document === 'undefined' ? null : document.activeElement
    const fromSection = Boolean(active && options.value?.contains(active))
    const fromCrumb = active !== null && active === crumb.value
    void nextTick(() => {
      if (next !== null && fromSection)
        crumb.value?.focus({ preventScroll: true })
      else if (next === null && fromCrumb)
        panel.value?.focus({ preventScroll: true })
    })
  },
)
</script>

<template>
  <Teleport to="body">
    <div v-if="open" ref="overlay" class="settings-overlay" role="presentation">
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
          <SettingsNav
            :active="section"
            :title-id="titleId"
            :marks="{ executors: upgrades.attention.value }"
            @select="select"
          />
          <div class="settings-content">
            <div class="settings-header">
              <h2 :id="sectionTitleId" class="section-title">
                <template v-if="header.trail.value">
                  <button
                    ref="crumb"
                    type="button"
                    class="section-crumb"
                    data-testid="settings-crumb"
                    @click="header.back()"
                  >
                    {{ sectionLabel }}
                  </button>
                  <DsChevronRight
                    class="section-crumb-separator"
                    :size="12"
                    aria-hidden="true"
                  />
                  <span
                    class="section-page"
                    data-testid="settings-page-title"
                    >{{ header.trail.value }}</span
                  >
                </template>
                <template v-else>{{ sectionLabel }}</template>
              </h2>
              <div class="header-actions">
                <SettingsHeaderBar :actions="header.actions.value" />
                <IconButton
                  class="settings-close"
                  label="关闭设置"
                  tooltip="关闭"
                  @click="close"
                >
                  <DsClose :size="14" />
                </IconButton>
              </div>
            </div>
            <div
              ref="options"
              class="settings-options"
              role="region"
              :aria-labelledby="sectionTitleId"
              :data-section="section"
              :data-page="header.page.value ?? undefined"
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
  background: var(--scrim);
  backdrop-filter: blur(var(--mask-blur));
}

.settings-panel {
  container: settings-panel / inline-size;
  position: relative;
  width: 880px;
  height: min(720px, calc(100vh - 80px));
  max-width: calc(100vw - 48px);
  overflow: hidden;
  border-radius: var(--r-xl);
  background: rgb(var(--surface-base));
  box-shadow: var(--shadow-lv3);
  color: rgb(var(--text-1));
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
  background: rgb(var(--surface-base));
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
  font-weight: var(--weight-semibold);
  color: rgb(var(--text-1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.section-title:has(.section-crumb) {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

/* The section name on a sub page: a quiet link back to its main page. */
.section-crumb {
  flex: none;
  margin: 0;
  padding: 0;
  border: none;
  border-radius: var(--radius-row);
  background: transparent;
  color: rgb(var(--text-3));
  font: inherit;
  cursor: pointer;
}

.section-crumb:hover {
  color: rgb(var(--text-1));
}

.section-crumb:focus-visible {
  outline: 2px solid rgb(var(--focus-ring));
  outline-offset: 2px;
}

.section-crumb-separator {
  flex: none;
  color: rgb(var(--text-3));
}

.section-page {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  margin-left: auto;
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
  color: rgb(var(--text-1));
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
