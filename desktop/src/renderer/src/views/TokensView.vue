<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useAppContext } from '../composables/useAppContext'
import OverviewSubPanel from '../components/panels/tokens/OverviewSubPanel.vue'
import ModelsSubPanel from '../components/panels/tokens/ModelsSubPanel.vue'
import CacheSubPanel from '../components/panels/tokens/CacheSubPanel.vue'
import { actionAssets } from '../assets'
import type { TokensRange, TokensTab } from '../types'

const ctx = useAppContext()

const tab = ref<TokensTab>('overview')
const range = ref<TokensRange>('all')

const tabs: { key: TokensTab; label: string }[] = [
  { key: 'overview', label: '概览' },
  { key: 'models', label: '模型' },
  { key: 'cache', label: '缓存' },
]

const ranges: { key: TokensRange; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: '30d', label: '30天' },
  { key: '7d', label: '7天' },
]

onMounted(async () => {
  if (!ctx.tokens.value) {
    await ctx.runSafely(() => ctx.loadTokens(true))
  }
})

function refresh() {
  ctx.runSafely(() => ctx.loadTokens(false))
}
</script>

<template>
  <section class="main-view view-readable">
    <header class="view-head tokens-head">
      <div class="min-w-0">
        <h1>用量账本</h1>
        <p>按模型、用途、日期统计的 Token 消耗</p>
      </div>
      <div class="tokens-controls">
        <div class="tokens-pill-group" role="tablist" aria-label="视图切换">
          <button
            v-for="t in tabs"
            :key="t.key"
            class="tokens-pill"
            :data-active="tab === t.key ? 'true' : 'false'"
            @click="tab = t.key"
          >
            {{ t.label }}
          </button>
        </div>
        <div class="tokens-pill-group" role="tablist" aria-label="时间过滤">
          <button
            v-for="r in ranges"
            :key="r.key"
            class="tokens-pill"
            :data-active="range === r.key ? 'true' : 'false'"
            @click="range = r.key"
          >
            {{ r.label }}
          </button>
        </div>
        <button class="tool-button asset-button refresh-action" title="刷新" @click="refresh">
          <img class="action-icon" :src="actionAssets.refresh" alt="" width="26" height="26" />
          <span>刷新</span>
        </button>
      </div>
    </header>
    <div class="view-body tokens-body">
      <div v-if="!ctx.tokens.value && ctx.tokensLoading.value" class="empty-note">加载 Token 统计中...</div>
      <OverviewSubPanel
        v-else-if="tab === 'overview'"
        :tokens="ctx.tokens.value"
        :range="range"
      />
      <ModelsSubPanel
        v-else-if="tab === 'models'"
        :tokens="ctx.tokens.value"
        :range="range"
      />
      <CacheSubPanel
        v-else
        :tokens="ctx.tokens.value"
        :range="range"
      />
    </div>
  </section>
</template>
