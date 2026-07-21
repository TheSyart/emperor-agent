<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useAppContext } from '../../composables/useAppContext'
import { navOrder } from '../../router'
import { actionIcons, navIcon as resolveNavIcon } from '../../icons'
import { useTheme } from '../../composables/useTheme'
import BrandMark from '../brand/BrandMark.vue'

const ctx = useAppContext()
const route = useRoute()
const { theme, toggle: toggleTheme } = useTheme()

const navItems = computed(() =>
  navOrder.map((name) => ({
    name,
    to: name === 'chat' ? '/chat' : `/${name}`,
  })),
)

const current = computed(() => ctx.boot.value?.modelConfig?.current)
const statusIcon = computed(() => {
  if (ctx.busy.value) return actionIcons.statusBusy
  if (ctx.status.value === 'error') return actionIcons.statusError
  return actionIcons.statusOnline
})
const modelLabel = computed(
  () =>
    current.value?.effectiveDisplayName ||
    current.value?.displayName ||
    `${current.value?.provider || 'provider'} / ${current.value?.modelId || 'model'}`,
)
</script>

<template>
  <aside class="nav-rail" aria-label="Primary navigation">
    <div class="rail-brand" :title="modelLabel">
      <BrandMark class="rail-brand-img" :size="24" />
    </div>

    <div class="rail-status" :title="ctx.runtimeText()">
      <component
        :is="statusIcon"
        class="status-icon"
        :size="13"
        :class="{
          'animate-spin': ctx.busy.value,
          error: ctx.status.value === 'error',
        }"
      />
    </div>

    <nav class="rail-actions">
      <router-link
        v-for="item in navItems"
        :key="item.name"
        :to="item.to"
        class="rail-action"
        :class="{ active: route.name === item.name }"
        :title="item.name"
      >
        <component :is="resolveNavIcon(item.name)" :size="18" />
      </router-link>
    </nav>

    <div class="rail-footer">
      <button
        class="rail-icon-button"
        :title="theme === 'dark' ? '切换浅色' : '切换深色'"
        @click="toggleTheme()"
      >
        <component
          :is="
            theme === 'dark' ? actionIcons.statusOnline : actionIcons.statusBusy
          "
          :size="16"
        />
      </button>
      <button
        class="rail-icon-button"
        title="清空当前屏幕"
        @click="ctx.clearChat()"
      >
        <component :is="actionIcons.clear" :size="16" />
      </button>
    </div>
  </aside>
</template>
