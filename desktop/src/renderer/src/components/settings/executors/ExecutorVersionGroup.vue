<script setup lang="ts">
/**
 * 设置 › 子智能体 › Claude Code / Codex › 版本 (AGT-13): 本机版本, 安装方式
 * (and where), 最新版本 (Codex: 尚未验证 when Emperor has not verified its
 * major.minor), Emperor 已验证 (Codex), then 升级到 x (the confirmation
 * first; 随桌面版更新 for a desktop app's copy), 检查更新 and when it last
 * checked — npm's public version numbers only. While it upgrades, the bar,
 * 查看过程 and 取消; a failure, its notice.
 *
 * Props: profileId. Emits: recheck(profileId).
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import Button from '../../ui/Button.vue'
import { SettingsGroup, SettingsRow } from '../ui'
import ExecutorUpgradeNotice from './ExecutorUpgradeNotice.vue'
import ExecutorUpgradeProgress from './ExecutorUpgradeProgress.vue'
import { useExecutorUpgrades } from './executorUpgrades'
import {
  activeRun,
  checkedText,
  installText,
  runningLine,
  upgradeOffered,
} from './upgradeText'

const props = defineProps<{ profileId: string }>()
const emit = defineEmits<{ recheck: [profileId: string] }>()

const upgrades = useExecutorUpgrades()
const version = computed(() => upgrades.versionOf(props.profileId))
const run = computed(() => upgrades.runOf(props.profileId))
const running = computed(() => activeRun(run.value))
const checking = ref(false)
const showLog = ref(false)
const now = ref(Date.now())
const timer = setInterval(() => {
  now.value = Date.now()
}, 1000)
onBeforeUnmount(() => clearInterval(timer))

const facts = computed(() => {
  const v = version.value
  if (!v) return []
  const versions = upgrades.versions.value
  return [
    {
      key: 'installed',
      term: '本机版本',
      value: v.installed ?? '未安装',
      location: null,
    },
    {
      key: 'install',
      term: '安装方式',
      value: installText(v),
      location: v.install.location,
    },
    {
      key: 'latest',
      term: '最新版本',
      value: v.latest
        ? v.unverified === v.latest
          ? `${v.latest} · 尚未验证`
          : v.latest
        : versions?.error
          ? '没有查到'
          : '还没有检查',
      location: null,
    },
    ...(v.backend === 'codex'
      ? [
          {
            key: 'verified',
            term: 'Emperor 已验证',
            value: v.verified.join('、'),
            location: null,
          },
        ]
      : []),
  ]
})

const action = computed(() => {
  const v = version.value
  if (!v) return { label: '', disabled: true }
  if (running.value) return { label: '正在升级…', disabled: true }
  if (v.target && v.upgrade?.manual === 'desktop')
    return { label: '随桌面版更新', disabled: true }
  if (upgradeOffered(v, run.value))
    return { label: `升级到 ${v.target}`, disabled: false }
  return {
    label: v.unverified ? '已是验证过的最新版' : '已是最新',
    disabled: true,
  }
})

const unverifiedLine = computed(() => {
  const next = version.value?.unverified
  if (!next) return ''
  const line = next.split('.').slice(0, 2).join('.')
  return `${line} 还没经过 Emperor 验证，现在升上去会显示「版本不兼容」，等 Emperor 更新后再升。`
})

async function check() {
  if (checking.value) return
  checking.value = true
  try {
    await upgrades.load(true)
  } finally {
    checking.value = false
  }
}
</script>

<template>
  <ExecutorUpgradeNotice
    :profile-id="profileId"
    @recheck="(id) => emit('recheck', id)"
  />
  <SettingsGroup v-if="version" title="版本" data-executor-versions>
    <SettingsRow layout="stacked">
      <dl class="facts">
        <div v-for="item in facts" :key="item.key" class="fact">
          <dt>{{ item.term }}</dt>
          <dd :data-version-fact="item.key">
            {{ item.value
            }}<template v-if="item.location"
              >{{ ' · '
              }}<code class="location">{{ item.location }}</code></template
            >
          </dd>
        </div>
      </dl>
      <p v-if="running && run" class="state" data-version-running>
        {{ runningLine(run, now) }}
      </p>
      <ExecutorUpgradeProgress
        v-if="running && run"
        :log="run.log"
        bar
        :show-log="showLog"
      />
      <div class="actions">
        <Button
          size="sm"
          variant="primary"
          data-version-upgrade
          :disabled="action.disabled"
          @click="upgrades.ask([profileId])"
          >{{ action.label }}</Button
        ><Button
          v-if="running"
          size="sm"
          variant="ghost"
          data-upgrade-show-log
          @click="showLog = !showLog"
          >{{ showLog ? '收起过程' : '查看过程' }}</Button
        ><Button
          v-if="running"
          size="sm"
          variant="ghost"
          data-upgrade-cancel
          @click="upgrades.cancel(profileId)"
          >取消</Button
        ><Button
          size="sm"
          variant="secondary"
          data-version-check
          :disabled="checking"
          @click="check"
          >{{ checking ? '检查中…' : '检查更新' }}</Button
        ><span class="checked" data-version-checked>{{
          upgrades.versions.value
            ? checkedText(upgrades.versions.value, now)
            : ''
        }}</span>
      </div>
      <p v-if="unverifiedLine" class="hint" data-version-unverified>
        {{ unverifiedLine }}
      </p>
    </SettingsRow>
  </SettingsGroup>
</template>

<style scoped>
.facts {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr);
  gap: var(--space-2) var(--space-3-5);
  margin: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.fact {
  display: contents;
}

.fact dt {
  color: rgb(var(--text-3));
}

.fact dd {
  min-width: 0;
  margin: 0;
  color: rgb(var(--text-1));
  overflow-wrap: anywhere;
}

.location {
  font-family: var(--font-mono);
  font-size: var(--fs-xxs);
  color: rgb(var(--text-2));
}

.state {
  margin: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--text-3));
}

.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-1);
}

.checked {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--text-3));
}

.hint {
  margin: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--state-warn-label));
}
</style>
