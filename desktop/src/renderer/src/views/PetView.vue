<script setup lang="ts">
import { computed, ref } from 'vue'
import { useAppContext } from '../composables/useAppContext'

const ctx = useAppContext()
const petBusy = ref(false)
const desktopPet = computed(() => ctx.boot.value?.desktopPet)

function toggleDesktopPet() {
  if (petBusy.value) return
  petBusy.value = true
  const next = !desktopPet.value?.enabled
  void ctx
    .runSafely(async () => {
      await ctx.setDesktopPetEnabled(next)
    })
    .finally(() => {
      petBusy.value = false
    })
}
</script>

<template>
  <section class="main-view">
    <header class="view-head">
      <div class="min-w-0">
        <h1>桌宠</h1>
        <p>Electron 桌面伴侣 — 实时动画、聊天气泡、空闲场景</p>
      </div>
      <span
        class="team-status-pill"
        :class="{ working: desktopPet?.running, error: desktopPet?.lastError }"
      >
        {{
          desktopPet?.running
            ? '运行中'
            : desktopPet?.enabled
              ? '待启动'
              : '已关闭'
        }}
      </span>
    </header>

    <div class="view-body view-body-fill">
      <div class="panel-content split-panel compact-split">
        <div class="config-layout">
          <!-- Preview & Controls -->
          <section class="pet-hero">
            <div class="pet-preview">
              <img
                src="../../../../../assets/desktop-pet/clawd-tank/clawd-idle-living.svg"
                alt="Clawd 桌宠预览"
                class="pet-preview-img"
              />
            </div>
            <div class="pet-info">
              <div class="pet-meta-row">
                <div class="pet-meta-item">
                  <span class="pet-meta-label">状态</span>
                  <span class="pet-meta-value">
                    {{ desktopPet?.running ? '运行中' : '未运行' }}
                  </span>
                </div>
                <div class="pet-meta-item">
                  <span class="pet-meta-label">启动方式</span>
                  <span class="pet-meta-value">
                    {{
                      desktopPet?.autoStartWithWebui
                        ? '跟随 WebUI 自动启动'
                        : '手动控制'
                    }}
                  </span>
                </div>
              </div>
              <p v-if="desktopPet?.lastError" class="pet-error">
                {{ desktopPet.lastError }}
              </p>
              <button
                class="tool-button wide ink pet-toggle"
                :disabled="petBusy"
                @click="toggleDesktopPet"
              >
                {{
                  petBusy
                    ? '处理中...'
                    : desktopPet?.enabled
                      ? '关闭桌宠'
                      : '开启桌宠'
                }}
              </button>
            </div>
          </section>

          <!-- Clawd sprites gallery -->
          <section class="pet-sprites">
            <h2>Clawd 动画精灵</h2>
            <p class="section-desc">14 种绑定到运行时事件的 SVG 动画状态</p>
            <div class="sprite-grid">
              <figure
                v-for="sprite in [
                  { src: 'clawd-idle-living', label: '待机' },
                  { src: 'clawd-working-thinking', label: '思考' },
                  { src: 'clawd-working-typing', label: '回复' },
                  { src: 'clawd-working-debugger', label: '查阅文件' },
                  { src: 'clawd-working-building', label: '运行命令' },
                  { src: 'clawd-working-conducting', label: '派遣队友' },
                  { src: 'clawd-working-wizard', label: '查看网页' },
                  { src: 'clawd-working-beacon', label: '外部工具' },
                  { src: 'clawd-working-sweeping', label: '扫除' },
                  { src: 'clawd-happy', label: '完成' },
                  { src: 'clawd-notification', label: '等待拍板' },
                  { src: 'clawd-dizzy', label: '出错' },
                  { src: 'clawd-sleeping', label: '睡觉' },
                  { src: 'clawd-disconnected', label: '断连' },
                ]"
                :key="sprite.src"
                class="sprite-card"
              >
                <img
                  :src="`../../../../../assets/desktop-pet/clawd-tank/${sprite.src}.svg`"
                  :alt="sprite.label"
                  class="sprite-img"
                />
                <figcaption>{{ sprite.label }}</figcaption>
              </figure>
            </div>
          </section>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.pet-hero {
  display: flex;
  gap: 24px;
  align-items: center;
  padding: 20px 0;
  border-bottom: 1px solid var(--color-border);
  margin-bottom: 24px;
}

.pet-preview {
  width: 140px;
  height: 160px;
  border-radius: var(--radius-lg);
  background: var(--color-surface-variant);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.pet-preview-img {
  width: 100px;
  height: 100px;
  filter: drop-shadow(0 2px 8px rgb(var(--shadow-color) / 0.25));
}

.pet-info {
  flex: 1;
  min-width: 0;
}

.pet-meta-row {
  display: flex;
  gap: 32px;
  margin-bottom: var(--space-3);
}

.pet-meta-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.pet-meta-label {
  font-size: var(--font-size-xs);
  color: var(--color-text-fg-muted);
  text-transform: uppercase;
}

.pet-meta-value {
  font-size: var(--font-size-lg);
  font-weight: 500;
}

.pet-error {
  color: var(--color-error);
  font-size: var(--font-size-md);
  margin-bottom: var(--space-3);
}

.pet-toggle {
  max-width: 180px;
}

.pet-sprites {
  padding-top: 8px;
}

.pet-sprites h2 {
  font-size: 16px;
  margin-bottom: 4px;
}

.section-desc {
  font-size: var(--font-size-md);
  color: var(--color-text-fg-muted);
  margin-bottom: 16px;
}

.sprite-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
  gap: var(--space-3);
}

.sprite-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) 8px;
  border-radius: var(--radius-lg);
  background: var(--color-surface-variant);
  transition: background 0.15s;
}

.sprite-card:hover {
  background: var(--color-surface-hover);
}

.sprite-img {
  width: 48px;
  height: 48px;
  filter: drop-shadow(0 1px 4px rgb(var(--shadow-color) / 0.2));
}

.sprite-card figcaption {
  font-size: var(--font-size-xs);
  color: var(--color-text-fg-muted);
}
</style>
