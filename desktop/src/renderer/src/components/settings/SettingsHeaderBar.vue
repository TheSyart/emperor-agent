<script setup lang="ts">
/**
 * SettingsHeaderBar — renders the header actions a section registered with
 * useSettingsHeader (see settingsHeader.ts): refresh / icon kinds as 28px
 * ghost IconButtons, secondary / primary kinds as 28px (sm) capsules, and
 * `menu` actions as dropdown triggers over ui/Menu. Tracks pending
 * promise-returning onClick handlers so the control disables (and the
 * refresh glyph spins) until they settle.
 *
 * Props: actions (SettingsHeaderAction[]).
 */
import { computed, reactive, ref, type ComponentPublicInstance } from 'vue'
import Button from '../ui/Button.vue'
import IconButton from '../ui/IconButton.vue'
import Menu from '../ui/Menu.vue'
import MenuItem from '../ui/MenuItem.vue'
import { DsChevronDown, DsRefresh } from '../icons/ds'
import type { SettingsHeaderAction } from './settingsHeader'

const props = defineProps<{ actions: readonly SettingsHeaderAction[] }>()

const pending = reactive(new Set<string>())
const anchors: Record<string, HTMLElement | null> = {}
const menuId = ref<string | null>(null)
const menuAnchor = ref<HTMLElement | null>(null)

const menuAction = computed(
  () => props.actions.find((action) => action.id === menuId.value) ?? null,
)
const menuOpen = computed({
  get: () => menuAction.value !== null,
  set: (value: boolean) => {
    if (!value) menuId.value = null
  },
})

function kindOf(action: SettingsHeaderAction) {
  return action.kind ?? 'secondary'
}

function isBusy(action: SettingsHeaderAction) {
  return Boolean(action.busy) || pending.has(action.id)
}

function setAnchor(id: string, el: Element | ComponentPublicInstance | null) {
  const node = el && '$el' in el ? (el.$el as Element | null) : el
  anchors[id] = node instanceof HTMLElement ? node : null
}

async function activate(action: SettingsHeaderAction) {
  if (action.disabled || isBusy(action)) return
  if (action.menu?.length) {
    if (menuId.value === action.id) {
      menuId.value = null
      return
    }
    menuAnchor.value = anchors[action.id] ?? null
    menuId.value = action.id
    return
  }
  const result = action.onClick?.()
  if (!(result instanceof Promise)) return
  pending.add(action.id)
  try {
    await result
  } catch {
    // Sections report their own failures; the header only tracks pending.
  } finally {
    pending.delete(action.id)
  }
}
</script>

<template>
  <div class="settings-header-bar">
    <template v-for="action in actions" :key="action.id">
      <IconButton
        v-if="kindOf(action) === 'refresh' || kindOf(action) === 'icon'"
        :ref="(el) => setAnchor(action.id, el)"
        :label="action.title ?? action.label"
        :disabled="action.disabled || isBusy(action)"
        :data-action="action.id"
        :data-busy="isBusy(action) || undefined"
        :aria-haspopup="action.menu?.length ? 'menu' : undefined"
        :aria-expanded="action.menu?.length ? menuId === action.id : undefined"
        @click="activate(action)"
      >
        <DsRefresh
          v-if="kindOf(action) === 'refresh'"
          :size="16"
          class="glyph"
          :class="{ spinning: isBusy(action) }"
        />
        <component :is="action.icon" v-else-if="action.icon" :size="16" />
      </IconButton>
      <Button
        v-else
        :ref="(el) => setAnchor(action.id, el)"
        size="sm"
        :variant="kindOf(action) === 'primary' ? 'primary' : 'outline'"
        :disabled="action.disabled || isBusy(action)"
        :title="action.title"
        :data-action="action.id"
        :data-busy="isBusy(action) || undefined"
        :aria-haspopup="action.menu?.length ? 'menu' : undefined"
        :aria-expanded="action.menu?.length ? menuId === action.id : undefined"
        @click="activate(action)"
      >
        <template v-if="action.icon" #icon>
          <component :is="action.icon" :size="14" />
        </template>
        {{ action.label }}
        <DsChevronDown v-if="action.menu?.length" :size="14" class="chevron" />
      </Button>
    </template>
    <Menu
      v-model:open="menuOpen"
      :anchor="menuAnchor"
      :label="menuAction?.label"
      :width="240"
      placement="bottom"
    >
      <MenuItem
        v-for="item in menuAction?.menu ?? []"
        :key="item.id"
        :description="item.description"
        :danger="item.danger"
        :disabled="item.disabled"
        :data-menu-item="item.id"
        @select="item.onSelect()"
      >
        <template v-if="item.icon" #icon>
          <component :is="item.icon" :size="16" />
        </template>
        {{ item.label }}
      </MenuItem>
    </Menu>
  </div>
</template>

<style scoped>
.settings-header-bar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  min-width: 0;
}

.glyph.spinning {
  animation: settings-header-spin 0.9s linear infinite;
}

.chevron {
  flex: none;
  margin-right: calc(-1 * var(--space-0-5));
  color: rgb(var(--label-caption));
}

@keyframes settings-header-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
