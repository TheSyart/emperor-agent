<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  AlertCircle,
  Ban,
  CheckCircle2,
  CircleDashed,
  LoaderCircle,
  RefreshCcw,
  TriangleAlert,
} from 'lucide-vue-next'
import { core } from '../../api/http'
import {
  environmentJobStatusLabel,
  environmentJobTone,
  environmentToolSections,
  environmentToolStatusLabel,
  environmentToolTone,
  type EnvironmentStatusPayload,
  type EnvironmentTool,
} from './environmentPanelModel'

const statusPayload = ref<EnvironmentStatusPayload | null>(null)
const loading = ref(false)
const error = ref('')

const sections = computed(() => environmentToolSections(statusPayload.value))

onMounted(() => void refresh(true))

defineExpose({ refresh })

async function refresh(forceRefresh = false) {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    statusPayload.value = await core('environment.getStatus', { forceRefresh })
  } catch (reason) {
    const value = reason as { message?: unknown }
    error.value =
      typeof value?.message === 'string' ? value.message : String(reason)
  } finally {
    loading.value = false
  }
}

function toolIcon(status: EnvironmentTool['status']) {
  if (status === 'ready') return CheckCircle2
  if (status === 'installing' || status === 'awaiting_user') return LoaderCircle
  if (status === 'blocked' || status === 'failed') return Ban
  if (status === 'missing' || status === 'version_mismatch')
    return TriangleAlert
  return CircleDashed
}

function platformLabel() {
  const status = statusPayload.value?.status
  if (!status) return '检测中'
  const platform =
    status.platform === 'darwin'
      ? 'macOS'
      : status.platform === 'win32'
        ? 'Windows'
        : 'Linux'
  return `${platform} · ${status.arch}`
}
</script>

<template>
  <section
    class="diagnostics-group environment-diagnostics"
    data-testid="environment-section"
  >
    <div class="diagnostics-group-head environment-head">
      <div>
        <strong>开发环境</strong>
        <span>{{ platformLabel() }}</span>
      </div>
      <button
        class="icon-button"
        :disabled="loading"
        title="重新检测环境"
        aria-label="重新检测环境"
        @click="refresh(true)"
      >
        <RefreshCcw :size="15" :class="{ spinning: loading }" />
      </button>
    </div>

    <p class="environment-note">
      此处只读取工具、版本和 Skill 依赖状态。安装依赖由 Agent
      通过普通命令权限执行，并使用独立命令验证结果。
    </p>

    <div v-if="error" class="environment-error" role="alert">
      <AlertCircle :size="18" />
      <span>{{ error }}</span>
    </div>

    <div v-if="loading && !statusPayload" class="environment-empty">
      <LoaderCircle :size="18" class="spinning" />
      <span>正在检测开发环境</span>
    </div>

    <div v-else class="environment-sections">
      <section
        v-for="section in sections"
        :key="section.id"
        class="environment-tool-group"
      >
        <div class="environment-tool-group-head">
          <strong>{{ section.title }}</strong>
          <span>{{ section.tools.length }} 项</span>
        </div>
        <div class="environment-tool-list">
          <div
            v-for="tool in section.tools"
            :key="tool.id"
            class="settings-row environment-tool-row"
            :class="`tone-${environmentToolTone(tool.status)}`"
            :data-testid="`environment-tool-${tool.id}`"
          >
            <component
              :is="toolIcon(tool.status)"
              :size="18"
              :class="{ spinning: tool.status === 'installing' }"
            />
            <div>
              <strong>{{ tool.id }}</strong>
              <span>{{ tool.reason }}</span>
              <small v-if="tool.versionSummary || tool.requiredVersion">
                {{ tool.versionSummary || '未检测到版本' }}
                <template v-if="tool.requiredVersion">
                  · 要求 {{ tool.requiredVersion }}
                </template>
              </small>
            </div>
            <code>{{ environmentToolStatusLabel(tool.status) }}</code>
          </div>
        </div>
      </section>

      <section
        v-if="statusPayload?.status.skills.length"
        class="environment-tool-group"
      >
        <div class="environment-tool-group-head">
          <strong>Skill 依赖</strong>
          <span>{{ statusPayload.status.skills.length }} 项</span>
        </div>
        <div class="environment-tool-list">
          <div
            v-for="skill in statusPayload.status.skills"
            :key="skill.skillName"
            class="settings-row environment-tool-row"
          >
            <CheckCircle2 v-if="skill.status === 'ready'" :size="18" />
            <TriangleAlert v-else :size="18" />
            <div>
              <strong>{{ skill.skillName }}</strong>
              <span>
                {{
                  skill.missing.join(' · ') ||
                  skill.unsupported.join(' · ') ||
                  '依赖已满足'
                }}
              </span>
            </div>
            <code>{{ skill.status }}</code>
          </div>
        </div>
      </section>

      <section
        v-if="statusPayload?.recentJobs.length"
        class="environment-tool-group"
      >
        <div class="environment-tool-group-head">
          <strong>历史安装任务</strong>
          <span>只读兼容记录</span>
        </div>
        <div class="environment-history">
          <div
            v-for="job in statusPayload.recentJobs"
            :key="job.jobId"
            :data-tone="environmentJobTone(job.status)"
          >
            <code>{{ job.jobId }}</code>
            <span>{{ environmentJobStatusLabel(job.status) }}</span>
          </div>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.environment-diagnostics {
  display: grid;
  gap: var(--space-3);
}

.environment-head,
.environment-head > div,
.environment-tool-group-head,
.environment-tool-row,
.environment-history > div,
.environment-error,
.environment-empty {
  display: flex;
  align-items: center;
}

.environment-head,
.environment-tool-group-head,
.environment-history > div {
  justify-content: space-between;
}

.environment-head > div {
  gap: var(--space-2);
}

.environment-head span,
.environment-tool-group-head span,
.environment-tool-row span,
.environment-tool-row small,
.environment-note {
  color: rgb(var(--fg) / var(--text-secondary));
}

.environment-note {
  margin: 0;
  font-size: var(--font-size-xs);
  line-height: 1.6;
}

.environment-error,
.environment-empty {
  gap: var(--space-2);
  min-height: 42px;
  padding: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
}

.environment-error {
  color: rgb(var(--danger));
}

.environment-sections,
.environment-tool-group,
.environment-tool-list,
.environment-history {
  display: grid;
  gap: var(--space-2);
}

.environment-tool-row {
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: var(--space-3);
}

.environment-tool-row > div {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.environment-tool-row span,
.environment-tool-row small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.environment-tool-row code,
.environment-history code {
  font-size: var(--font-size-2xs);
}

.environment-history > div {
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
}

.tone-ok > svg,
[data-tone='ok'] span {
  color: rgb(var(--success));
}

.tone-warn > svg,
[data-tone='warn'] span {
  color: rgb(var(--warning));
}

.tone-error > svg,
[data-tone='error'] span {
  color: rgb(var(--danger));
}

.spinning {
  animation: environment-spin 0.9s linear infinite;
}

@keyframes environment-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
