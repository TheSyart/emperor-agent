<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CoreOperationResult } from '@emperor/core/api'
import {
  AlertCircle,
  PackageCheck,
  PlugZap,
  ShieldCheck,
} from 'lucide-vue-next'
import { core } from '../../api/http'

type PluginSummary = CoreOperationResult<'plugins.list'>[number]
type PluginPreview = CoreOperationResult<'plugins.inspect'>
type PluginScope = 'user' | 'project' | 'local'

const props = defineProps<{ plugins: PluginSummary[] }>()
const emit = defineEmits<{ changed: [] }>()

const sourceUrl = ref('')
const preview = ref<PluginPreview | null>(null)
const scope = ref<PluginScope>('user')
const loading = ref(false)
const error = ref('')

const capabilityRows = computed(() => {
  if (!preview.value) return []
  return [
    ['Skill', preview.value.capabilities.skills],
    ['Agent', preview.value.capabilities.agents],
    ['Hook', preview.value.capabilities.hooks],
    ['MCP', preview.value.capabilities.mcpServers],
    ['LSP', preview.value.capabilities.lspServers],
    ['Command', preview.value.capabilities.commands],
  ].filter(([, values]) => (values as readonly string[]).length)
})

async function inspectPlugin() {
  const url = sourceUrl.value.trim()
  if (!url || loading.value) return
  await run(async () => {
    preview.value = await core('plugins.inspect', { kind: 'url', url })
  })
}

async function installPlugin() {
  const current = preview.value
  if (!current || loading.value) return
  await run(async () => {
    await core('plugins.install', {
      previewId: current.previewId,
      digest: current.digest,
      scope: scope.value,
    })
    preview.value = null
    sourceUrl.value = ''
    emit('changed')
  })
}

async function togglePlugin(plugin: PluginSummary) {
  if (plugin.scope === 'managed') return
  const mutableScope = plugin.scope
  await run(async () => {
    await core('plugins.setEnabled', {
      pluginId: plugin.pluginId,
      scope: mutableScope,
      enabled: !plugin.enabled,
    })
    emit('changed')
  })
}

async function uninstallPlugin(plugin: PluginSummary) {
  if (plugin.scope === 'managed') return
  const mutableScope = plugin.scope
  if (!window.confirm(`卸载 Plugin「${plugin.name}」？持久数据不会被删除。`))
    return
  await run(async () => {
    await core('plugins.uninstall', {
      pluginId: plugin.pluginId,
      scope: mutableScope,
    })
    emit('changed')
  })
}

async function run(task: () => Promise<void>) {
  loading.value = true
  error.value = ''
  try {
    await task()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

function scopeLabel(value: string): string {
  if (value === 'project') return '项目'
  if (value === 'local') return '本地项目'
  if (value === 'managed') return '受管'
  return '用户'
}

function signatureLabel(status: string): string {
  if (status === 'verified') return '签名已验证'
  if (status === 'local_user_source') return '本地用户来源'
  return '未验证签名'
}

function sourceLabel(source: PluginPreview['source']): string {
  if (source.kind === 'url') return source.url
  if (source.kind === 'local') return source.label
  return source.marketplace
}
</script>

<template>
  <div class="panel-content capability-panel">
    <div class="panel-toolbar">
      <div class="filter-wrap">
        <input
          v-model="sourceUrl"
          data-testid="plugin-source"
          type="url"
          placeholder="HTTPS Plugin 压缩包地址"
          autocomplete="off"
          @keyup.enter="inspectPlugin"
        />
      </div>
      <button
        class="tool-button asset-button primary-action"
        data-testid="inspect-plugin"
        :disabled="loading || !sourceUrl.trim()"
        @click="inspectPlugin"
      >
        <PlugZap :size="16" />
        <span>{{ loading ? '检查中' : '检查 Plugin' }}</span>
      </button>
    </div>

    <div v-if="error" class="inline-error" role="alert">
      <AlertCircle :size="16" />
      <span>{{ error }}</span>
    </div>

    <div class="capability-card-grid panel-scroll">
      <article
        v-for="plugin in props.plugins"
        :key="`${plugin.pluginId}:${plugin.scope}`"
        class="capability-card"
      >
        <div class="capability-card-icon"><PackageCheck :size="20" /></div>
        <div class="capability-card-main">
          <div class="capability-card-head">
            <strong>{{ plugin.name }}</strong>
            <span class="badge">{{ scopeLabel(plugin.scope) }}</span>
          </div>
          <p>{{ plugin.pluginId }} · {{ plugin.version || '未物化' }}</p>
          <div class="capability-card-badges">
            <span class="badge" :class="plugin.enabled ? 'green' : ''">
              {{ plugin.enabled ? '已启用' : '已停用' }}
            </span>
            <span
              v-if="plugin.materialization === 'missing'"
              class="badge gold"
            >
              缺少内容
            </span>
            <span
              v-else-if="plugin.activation === 'blocked_unverified'"
              class="badge gold"
            >
              签名未验证 · 未激活
            </span>
          </div>
        </div>
        <div class="capability-card-actions">
          <button
            class="tool-button"
            :disabled="loading || plugin.scope === 'managed'"
            @click="togglePlugin(plugin)"
          >
            {{ plugin.enabled ? '停用' : '启用' }}
          </button>
          <button
            class="tool-button danger"
            :disabled="loading || plugin.scope === 'managed'"
            @click="uninstallPlugin(plugin)"
          >
            卸载
          </button>
        </div>
      </article>

      <div v-if="!props.plugins.length" class="empty-state illustrated-empty">
        <PlugZap :size="56" :stroke-width="1" />
        <span>尚未安装 Plugin。裸 Skill 不需要在这里安装。</span>
      </div>
    </div>

    <div v-if="preview" class="modal-backdrop" @click.self="preview = null">
      <section class="confirm-dialog" role="dialog" aria-modal="true">
        <header>
          <div>
            <h2>{{ preview.name }}</h2>
            <p>{{ preview.pluginId }} · {{ preview.version }}</p>
          </div>
          <ShieldCheck :size="22" />
        </header>

        <dl class="diagnostic-list">
          <div>
            <dt>来源</dt>
            <dd>{{ sourceLabel(preview.source) }}</dd>
          </div>
          <div>
            <dt>版本</dt>
            <dd>{{ preview.version }}</dd>
          </div>
          <div>
            <dt>Digest</dt>
            <dd>
              <code>{{ preview.digest.slice(0, 16) }}…</code>
            </dd>
          </div>
          <div>
            <dt>签名</dt>
            <dd>{{ signatureLabel(preview.signature.status) }}</dd>
          </div>
          <div>
            <dt>Scope</dt>
            <dd>
              <select v-model="scope">
                <option value="user">用户</option>
                <option value="project">项目</option>
                <option value="local">本地项目</option>
              </select>
            </dd>
          </div>
        </dl>

        <div class="capability-card-badges">
          <span
            v-for="row in capabilityRows"
            :key="String(row[0])"
            class="badge"
          >
            {{ row[0] }} · {{ (row[1] as readonly string[]).length }}
          </span>
        </div>

        <footer class="dialog-actions">
          <button class="tool-button" @click="preview = null">取消</button>
          <button
            class="tool-button ink"
            data-testid="confirm-plugin-install"
            :disabled="loading"
            @click="installPlugin"
          >
            {{ loading ? '安装中' : '确认安装' }}
          </button>
        </footer>
      </section>
    </div>
  </div>
</template>
