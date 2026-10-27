<script setup lang="ts">
/**
 * 设置 › 常规's last card, 关于 (BRD-04): 小单 in the robe (the brand image),
 * the name, one line of what Emperor is, and the 「单」 seal as its
 * signature, the way a painter stamps a scroll. 显示吉祥物 off takes the
 * figure away; the seal stays. The version is the 更新 card's, above it.
 */
import robe from '../../assets/mascot/robe.webp'
import seal from '../../assets/mascot/seal-dan.webp'
import { useUiPreferences } from '../../composables/useUiPreferences'
import { SettingsGroup } from './ui'

const { preferences } = useUiPreferences()
</script>

<template>
  <SettingsGroup title="关于" data-group="about">
    <div class="about">
      <img
        v-if="preferences.showMascot"
        class="figure"
        :src="robe"
        alt=""
        draggable="false"
        data-about-figure
      />
      <div class="words">
        <p class="name">Emperor Agent</p>
        <p class="line">你做决定，agent 们办事。</p>
        <p class="sign">
          <img
            class="seal"
            :src="seal"
            alt="「单」字印"
            draggable="false"
            data-about-seal
          />
          <span>单 出品</span>
        </p>
      </div>
    </div>
  </SettingsGroup>
</template>

<style scoped>
.about {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-4);
}

.figure {
  flex: none;
  height: 96px;
  width: auto;
  user-select: none;
}

.words {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.words p {
  margin: 0;
}

.name {
  color: rgb(var(--text-1));
  font-size: var(--fs-md);
  font-weight: var(--weight-semibold);
}

.line {
  color: rgb(var(--text-2));
  font-size: var(--fs-xs);
}

.words .sign {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  margin-top: var(--space-1);
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
}

.seal {
  width: 22px;
  height: 22px;
  user-select: none;
}
</style>
