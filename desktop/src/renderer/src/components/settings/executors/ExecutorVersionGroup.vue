<script setup lang="ts">
/**
 * 设置 › 子智能体 › Claude Code / Codex › 版本 (AGT-13): 本机版本, 安装方式
 * (and where), 最新版本 (Codex: 尚未验证 when Emperor has not verified its
 * major.minor), Emperor 已验证 (Codex), then 升级到 x (the confirmation
 * first; 随桌面版更新 for a desktop app's copy), 检查更新 and when it last
 * checked — npm's public version numbers only. While it upgrades, the bar,
 * 查看过程 and 取消; a failure, its notice.
 *
 * 退回 (VER-03, BUG-00 preview § 8): when the installed version failed for
 * its version and an earlier one ran a task, under 本机版本 the reason and
 * 「退回 x（上次正常）」 (its confirmation first; without one click it shows
 * the command to copy); a desktop app's copy only says why not.
 *
 * 自检 (VER-04, preview § 8): beside 本机版本 自检通过 / 不兼容 / 正在自检…
 * and, for Claude Code, 尚未验证; under it why (已自动关闭内置插件 …, the
 * reason it is incompatible) and 重新检查. A disabled 已是最新 never sits
 * beside 退回 or a refused version.
 *
 * Props: profileId. Emits: recheck(profileId).
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import Badge from '../../ui/Badge.vue'
import Button from '../../ui/Button.vue'
import { SettingsGroup, SettingsRow } from '../ui'
import ExecutorUpgradeNotice from './ExecutorUpgradeNotice.vue'
import ExecutorUpgradeProgress from './ExecutorUpgradeProgress.vue'
import { useExecutorUpgrades } from './executorUpgrades'
import {
  activeRun,
  checkedText,
  heldBack,
  installText,
  primaryShown,
  rollbackAction,
  rollbackOffered,
  runningLine,
  runVerb,
  selfCheckBadges,
  selfCheckNotes,
  selfCheckWarnings,
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
  if (running.value)
    return { label: `正在${runVerb(run.value)}…`, disabled: true }
  if (v.target && v.upgrade?.manual === 'desktop')
    return { label: '随桌面版更新', disabled: true }
  if (upgradeOffered(v, run.value))
    return { label: `升级到 ${v.target}`, disabled: false }
  // A newer release not offered: the one the user went back from (VER-03).
  if (heldBack(v)) return { label: '暂不升级', disabled: true }
  return {
    label: v.unverified ? '已是验证过的最新版' : '已是最新',
    disabled: true,
  }
})

/** 退回 under 本机版本 (VER-03): the reason, then the button or why not. */
const rollback = computed(() => {
  const v = version.value
  if (!v?.rollback || !rollbackOffered(v, run.value)) return null
  return {
    // A reason the self-check already gave is not said twice (VER-04).
    because: v.rollback.because.includes('自检不兼容')
      ? ''
      : v.rollback.because,
    ...rollbackAction(v),
  }
})

/** Beside and under 本机版本 (VER-04). */
const badges = computed(() =>
  version.value ? selfCheckBadges(version.value) : [],
)
const notes = computed(() =>
  version.value ? selfCheckNotes(version.value) : [],
)
const warnings = computed(() =>
  version.value ? selfCheckWarnings(version.value) : [],
)
const selfChecking = ref(false)
const rechecking = computed(
  () => !!version.value?.selfChecking || selfChecking.value,
)
async function recheck() {
  if (rechecking.value) return
  selfChecking.value = true
  try {
    await upgrades.selfCheck(props.profileId)
  } finally {
    selfChecking.value = false
  }
}

const unverifiedLine = computed(() => {
  // Codex's line (AGT-13); Claude Code says it beside 本机版本 (VER-04).
  if (version.value?.backend !== 'codex') return ''
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
        <template v-for="item in facts" :key="item.key">
          <div class="fact">
            <dt>{{ item.term }}</dt>
            <dd v-if="item.key === 'installed'" class="installed">
              <span data-version-fact="installed">{{ item.value }}</span
              ><Badge
                v-for="badge in badges"
                :key="badge.text"
                :tone="badge.tone"
                data-version-badge
                >{{ badge.text }}</Badge
              >
            </dd>
            <dd v-else :data-version-fact="item.key">
              {{ item.value
              }}<template v-if="item.location"
                >{{ ' · '
                }}<code class="location">{{ item.location }}</code></template
              >
            </dd>
          </div>
          <div
            v-if="item.key === 'installed' && version.installed && !running"
            class="fact"
            data-version-state
            :data-version-rollback="rollback ? '' : undefined"
          >
            <dt />
            <dd class="rollback">
              <span
                v-for="note in notes"
                :key="note"
                class="because"
                data-version-note
                >{{ note }}</span
              >
              <span
                v-for="warning in warnings"
                :key="warning"
                class="warning"
                data-version-warning
                >{{ warning }}</span
              >
              <span
                v-if="rollback?.because"
                class="because"
                data-version-rollback-because
                >{{ rollback.because }}</span
              >
              <span
                v-if="rollback?.note"
                class="because"
                data-version-rollback-note
                >{{ rollback.note }}</span
              >
              <span class="rollback-actions"
                ><Button
                  v-if="rollback?.label"
                  size="sm"
                  variant="secondary"
                  data-version-rollback-button
                  @click="upgrades.askRollback(profileId)"
                  >{{ rollback.label }}</Button
                ><Button
                  size="sm"
                  variant="ghost"
                  data-version-recheck
                  :disabled="rechecking"
                  @click="recheck"
                  >{{ rechecking ? '检查中…' : '重新检查' }}</Button
                ></span
              >
            </dd>
          </div>
        </template>
      </dl>
      <p v-if="running && run" class="state" data-version-running>
        {{ runningLine(run, now) }}
      </p>
      <ExecutorUpgradeProgress
        v-if="running && run"
        :log="run.log"
        :label="`${runVerb(run)}进度`"
        bar
        :show-log="showLog"
      />
      <div class="actions">
        <Button
          v-if="version && primaryShown(version, run)"
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

.installed {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1-5);
}

.rollback-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1-5);
}

.rollback {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-1-5);
  margin-top: calc(-1 * var(--space-1));
}

.because {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--text-3));
}

.warning {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--state-warn-label));
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
