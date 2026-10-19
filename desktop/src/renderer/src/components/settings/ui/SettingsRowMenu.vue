<script setup lang="ts">
/**
 * SettingsRowMenu — a row's 「⋯」 (UI-S07): the row keeps its one main
 * action as a button and puts the rest, deletes included, in this menu.
 *
 * Props: items ({ id, label, danger?, disabled?, onSelect }), label? (the
 * button's accessible name, default 「更多操作」).
 */
import { ref } from 'vue'
import { DsMore } from '../../icons/ds'
import IconButton from '../../ui/IconButton.vue'
import Menu from '../../ui/Menu.vue'
import MenuItem from '../../ui/MenuItem.vue'
import type { SettingsRowMenuItem } from './types'

withDefaults(
  defineProps<{ items: readonly SettingsRowMenuItem[]; label?: string }>(),
  { label: '更多操作' },
)

const open = ref(false)
const anchor = ref<HTMLElement | null>(null)
</script>

<template>
  <span ref="anchor" class="ds-settings-row-menu">
    <IconButton
      size="sm"
      :label="label"
      :aria-expanded="open"
      aria-haspopup="menu"
      @click="open = !open"
    >
      <DsMore :size="16" />
    </IconButton>
  </span>
  <Menu
    v-model:open="open"
    :anchor="anchor"
    :width="160"
    placement="bottom"
    dense
    :label="label"
  >
    <MenuItem
      v-for="item in items"
      :key="item.id"
      :danger="item.danger"
      :disabled="item.disabled"
      :data-menu-item="item.id"
      @select="item.onSelect()"
    >
      {{ item.label }}
    </MenuItem>
  </Menu>
</template>

<style scoped>
.ds-settings-row-menu {
  display: inline-flex;
}
</style>
