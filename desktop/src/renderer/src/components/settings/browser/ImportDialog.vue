<script setup lang="ts">
/**
 * 从浏览器导入 (ST-06) — a dialog that reads a local Chrome/Edge profile and
 * imports its saved passwords into the password manager and its cookies into a
 * persistent 登录状态 profile. Reading, decrypting and writing all happen in
 * main; this dialog only picks a source, shows whether the browser is still
 * running, and reports counts. It never sees a password or a cookie value.
 */
import EmptyState from '../../ui/EmptyState.vue'
import { computed, ref, watch } from 'vue'
import {
  fetchBrowserImportSources,
  runBrowserImport,
  vaultStatus,
  type BrowserImportSource,
} from '../../../api/backend'
import { core } from '../../../api/http'
import type { BrowserProfileView } from '@emperor/core/runtime-contract'
import Button from '../../ui/Button.vue'
import Modal from '../../ui/Modal.vue'
import { Select, Switch, type SelectOption } from '../ui'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()

interface FlatSource {
  browser: 'chrome' | 'edge'
  browserName: string
  shortName: string
  dir: string
  profileName: string
  running: boolean
}

const loading = ref(false)
const sources = ref<BrowserImportSource[]>([])
const profiles = ref<BrowserProfileView[]>([])
const selected = ref(0)
const wantPasswords = ref(true)
const wantCookies = ref(true)
const targetProfileId = ref('') // '' → create a new profile on import
const busy = ref(false)
const error = ref('')
const result = ref<{ passwords: number; sites: number } | null>(null)

const shortNames: Record<'chrome' | 'edge', string> = {
  chrome: 'Chrome',
  edge: 'Edge',
}

/** Installed browsers × their profiles, flattened for the source dropdown. */
const flatSources = computed<FlatSource[]>(() =>
  sources.value
    .filter((browser) => browser.installed)
    .flatMap((browser) => {
      const list = browser.profiles.length
        ? browser.profiles
        : [{ dir: 'Default', name: '默认' }]
      return list.map((profile) => ({
        browser: browser.browser,
        browserName: browser.name,
        shortName: shortNames[browser.browser],
        dir: profile.dir,
        profileName: profile.name,
        running: browser.running,
      }))
    }),
)

const sourceOptions = computed<SelectOption<number>[]>(() =>
  flatSources.value.map((source, index) => ({
    value: index,
    label: `${source.browserName} · ${source.profileName}`,
  })),
)

const current = computed<FlatSource | null>(
  () => flatSources.value[selected.value] ?? null,
)

const persistentProfiles = computed(() =>
  profiles.value.filter((profile) => profile.kind === 'persistent'),
)

const targetOptions = computed<SelectOption<string>[]>(() => [
  ...persistentProfiles.value.map((profile) => ({
    value: profile.profileId,
    label: profile.name,
  })),
  {
    value: '',
    label: current.value
      ? `新建「从 ${current.value.shortName} 导入」`
      : '新建',
  },
])

const nothingSelected = computed(
  () => !wantPasswords.value && !wantCookies.value,
)
const canImport = computed(
  () =>
    !busy.value &&
    !loading.value &&
    current.value !== null &&
    !current.value.running &&
    !nothingSelected.value,
)

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  result.value = null
  try {
    const [importSources, profileList] = await Promise.all([
      fetchBrowserImportSources(),
      core('computerUse.listProfiles').catch(() => [] as BrowserProfileView[]),
    ])
    sources.value = importSources.browsers
    profiles.value = profileList
    selected.value = 0
    targetProfileId.value = persistentProfiles.value[0]?.profileId ?? ''
  } finally {
    loading.value = false
  }
}

async function recheck(): Promise<void> {
  const keep = selected.value
  await load()
  if (keep < flatSources.value.length) selected.value = keep
}

function close(): void {
  emit('update:open', false)
}

/** Ensures a persistent profile to write cookies into, creating one if asked. */
async function resolveTargetProfile(source: FlatSource): Promise<string> {
  if (targetProfileId.value) return targetProfileId.value
  const name = `从 ${source.shortName} 导入`
  const created = await core('computerUse.manageProfile', {
    action: 'create',
    name,
  })
  const id = created.profile?.profileId
  if (!id) throw new Error('profile-create-failed')
  return id
}

const REASONS: Record<string, string> = {
  'browser-running': '请先完全关闭该浏览器，再导入。',
  'vault-locked': '请先解锁密码管理器，再导入密码。',
  'vault-unavailable': '密码管理器当前不可用。',
  'no-target-profile': '请选择要写入登录状态的 profile。',
  'read-failed': '读取浏览器数据失败，请确认浏览器已完全关闭。',
  'nothing-selected': '请至少选择一项要导入的数据。',
  internal: '导入失败，请稍后再试。',
}

async function submit(): Promise<void> {
  const source = current.value
  if (!source || busy.value) return
  busy.value = true
  error.value = ''
  result.value = null
  try {
    // The vault must be unlocked to add passwords; we prompt, never unlock.
    if (wantPasswords.value) {
      const status = await vaultStatus().catch(() => null)
      if (status && !status.available) {
        error.value = REASONS['vault-unavailable']
        return
      }
      if (status?.locked) {
        error.value = '请先在「密码管理器」里解锁，再回来导入密码。'
        return
      }
    }
    let target: string | undefined
    if (wantCookies.value) {
      try {
        target = await resolveTargetProfile(source)
      } catch {
        error.value = '无法新建登录状态 profile，请在「登录状态」里手动新建。'
        return
      }
    }
    const outcome = await runBrowserImport({
      browser: source.browser,
      profileDir: source.dir,
      passwords: wantPasswords.value,
      cookies: wantCookies.value,
      ...(target === undefined ? {} : { targetProfileId: target }),
    })
    if (outcome.ok) {
      result.value = { passwords: outcome.passwords, sites: outcome.sites }
      // Refresh profiles so a freshly created one shows next time.
      profiles.value = await core('computerUse.listProfiles').catch(
        () => profiles.value,
      )
    } else {
      error.value = REASONS[outcome.reason] ?? REASONS.internal
    }
  } finally {
    busy.value = false
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) void load()
  },
  { immediate: true },
)
</script>

<template>
  <Modal
    :open="open"
    title="从浏览器导入"
    description="选择要导入到内置浏览器的数据"
    :width="460"
    @update:open="(value: boolean) => emit('update:open', value)"
  >
    <div class="import-body">
      <EmptyState
        v-if="!loading && flatSources.length === 0"
        title="没有可导入的浏览器"
        description="请确认本机装有 Google Chrome 或 Microsoft Edge。"
      />
      <template v-else>
        <label class="import-source-row">
          <span class="import-label">从</span>
          <Select
            data-testid="import-source"
            size="sm"
            :model-value="selected"
            :options="sourceOptions"
            :disabled="busy"
            aria-label="导入来源"
            @update:model-value="
              (value?: number) => value !== undefined && (selected = value)
            "
          />
        </label>

        <p
          v-if="current?.running"
          class="import-running"
          data-testid="import-running"
          role="alert"
        >
          导入前，请完全关闭 {{ current.browserName }}
          <button
            type="button"
            class="import-recheck"
            data-testid="import-recheck"
            @click="recheck"
          >
            重新检查
          </button>
        </p>

        <div class="import-toggles">
          <label class="import-toggle">
            <span>已保存的密码</span>
            <Switch
              data-testid="import-passwords"
              :model-value="wantPasswords"
              aria-label="导入已保存的密码"
              @update:model-value="(value: boolean) => (wantPasswords = value)"
            />
          </label>
          <label class="import-toggle">
            <span>Cookie（登录状态）</span>
            <Switch
              data-testid="import-cookies"
              :model-value="wantCookies"
              aria-label="导入 Cookie 登录状态"
              @update:model-value="(value: boolean) => (wantCookies = value)"
            />
          </label>
          <label v-if="wantCookies" class="import-target-row">
            <span class="import-target-label">写入登录状态</span>
            <Select
              data-testid="import-target"
              size="sm"
              :model-value="targetProfileId"
              :options="targetOptions"
              :disabled="busy"
              aria-label="写入的登录状态 profile"
              @update:model-value="
                (value?: string) =>
                  value !== undefined && (targetProfileId = value)
              "
            />
          </label>
        </div>

        <p class="import-note">
          导入在本机完成：读取密码需要 macOS
          钥匙串授权，系统会弹窗；不导入浏览记录。
        </p>

        <p
          v-if="result"
          class="import-result"
          data-testid="import-result"
          role="status"
        >
          导入了 {{ result.passwords }} 个密码、{{ result.sites }}
          个网站的登录。
        </p>
        <p
          v-else-if="error"
          class="import-error"
          data-testid="import-error"
          role="alert"
        >
          {{ error }}
        </p>
      </template>
    </div>
    <template #footer>
      <Button variant="secondary" type="button" @click="close">
        {{ result ? '完成' : '取消' }}
      </Button>
      <Button
        v-if="!result"
        variant="primary"
        type="button"
        data-testid="import-run"
        :disabled="!canImport"
        @click="submit"
      >
        {{ busy ? '正在导入…' : '导入' }}
      </Button>
    </template>
  </Modal>
</template>

<style scoped>
.import-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.import-source-row,
.import-target-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.import-label {
  font-size: var(--fs-s);
  color: rgb(var(--label-secondary));
}

.import-source-row :deep(.ds-select),
.import-target-row :deep(.ds-select) {
  flex: 1;
  min-width: 0;
}

.import-running {
  margin: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-secondary));
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.import-recheck {
  border: none;
  background: none;
  padding: 0;
  color: rgb(var(--accent-strong));
  cursor: pointer;
  font: inherit;
}

.import-recheck:hover {
  text-decoration: underline;
}

.import-toggles {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.import-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  font-size: var(--fs-s);
  color: rgb(var(--label-primary));
}

.import-target-row {
  padding-top: var(--space-1);
}

.import-target-label {
  font-size: var(--fs-xs);
  color: rgb(var(--label-secondary));
}

.import-note {
  margin: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
  text-wrap: pretty;
}

.import-result {
  margin: 0;
  font-size: var(--fs-s);
  color: rgb(var(--label-primary));
}

.import-error {
  margin: 0;
  font-size: var(--fs-s);
  color: rgb(var(--state-error-label));
}
</style>
