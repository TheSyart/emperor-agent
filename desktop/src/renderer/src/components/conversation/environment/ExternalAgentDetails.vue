<script setup lang="ts">
/** One durable external run. Execution and exact-tree acceptance are separate facts. */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import {
  getDelegation,
  getDelegationReceipt,
  sendDelegationMessage,
  interruptDelegation,
  recoverDelegation,
  collectDelegation,
  validateDelegation,
  integrateDelegation,
  closeDelegation,
  type DelegationView,
  type DelegationDelivery,
} from '../../../api/delegations'
import { onCoreEvent } from '../../../api/backend'
import Modal from '../../ui/Modal.vue'
import Button from '../../ui/Button.vue'
import TaskOutputDialog from './TaskOutputDialog.vue'
const props = defineProps<{
  runId: string
  delegationId: string
  sessionId?: string
}>()
const emit = defineEmits<{ close: []; configure: [] }>()
const view = shallowRef<DelegationView | null>(null),
  delivery = shallowRef<DelegationDelivery | null>(null),
  busy = ref(false),
  stopping = ref(false),
  verifying = ref(false),
  error = ref(''),
  followup = ref(''),
  showOutput = ref(false),
  command = ref(''),
  args = ref('["test"]'),
  criterion = ref('项目测试'),
  reviewed = ref(false),
  requiresReview = ref(false),
  nativeHistory = ref('')
let generation = 0,
  alive = true,
  timer: ReturnType<typeof setTimeout> | undefined,
  unsubscribe = () => {}
const failureDisposition = ref('')
const record = computed(() => view.value?.record),
  run = computed(() => view.value?.runs[props.runId]),
  receipt = computed(() => delivery.value?.receipt),
  preview = computed(() => delivery.value?.preview)
const phases: Record<string, string> = {
  queued: '等待调度',
  preparing: '正在准备',
  running: '正在执行',
  waiting_input: '等待回答',
  cancelling: '正在停止',
  completed: '本轮执行完成',
  failed: '本轮执行失败',
  cancelled: '本轮已取消',
  interrupted: '本轮已中断',
  outcome_unknown: '执行结果待恢复确认',
}
const acceptance = computed(
  () => delivery.value?.acceptance?.state ?? 'unverified',
)
const acceptanceLabel = computed(
  () =>
    ({
      unverified: '未验证',
      passed: '验收通过',
      failed: '验收失败',
      needs_user: '需要处理',
    })[acceptance.value],
)
const active = computed(() =>
  ['queued', 'preparing', 'running', 'waiting_input', 'cancelling'].includes(
    run.value?.phase ?? '',
  ),
)
const steer = computed(
  () =>
    record.value?.backend === 'codex' &&
    record.value.capabilitySnapshot.steer &&
    record.value.currentRunId === props.runId &&
    run.value?.phase === 'running',
)
const mutable = computed(
  () =>
    record.value?.availability !== 'closed' &&
    record.value?.availability !== 'needs_recovery',
)
const verifyingNow = computed(
  () => verifying.value || delivery.value?.verificationActive === true,
)
const canApply = computed(
  () => preview.value?.status === 'ready' && acceptance.value === 'passed',
)
async function load() {
  const current = ++generation
  const [state, result] = await Promise.allSettled([
    getDelegation({ id: props.delegationId, sessionId: props.sessionId }),
    getDelegationReceipt({ runId: props.runId, sessionId: props.sessionId }),
  ])
  if (!alive || current !== generation) return
  if (state.status === 'fulfilled') view.value = state.value
  else error.value = String(state.reason)
  if (result.status === 'fulfilled') {
    if (result.value.receipt?.id !== delivery.value?.receipt?.id)
      reviewed.value = false
    delivery.value = result.value
  } else error.value = String(result.reason)
}
function refresh() {
  error.value = ''
  void load()
}
async function action(task: () => Promise<unknown>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await task()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (alive) {
      await load()
      busy.value = false
    }
  }
}
function send(deliveryMode: 'queue' | 'steer') {
  if (!followup.value.trim()) return
  return action(async () => {
    await sendDelegationMessage({
      id: props.delegationId,
      sessionId: props.sessionId,
      messageId: 'dgm-' + crypto.randomUUID(),
      text: followup.value,
      delivery: deliveryMode,
      ...(deliveryMode === 'steer' ? { expectedRunId: props.runId } : {}),
    })
    followup.value = ''
  })
}
async function stop() {
  if (stopping.value) return
  stopping.value = true
  error.value = ''
  try {
    await interruptDelegation({
      id: props.delegationId,
      runId: props.runId,
      sessionId: props.sessionId,
    })
  } catch (cause) {
    error.value = String(cause)
  } finally {
    if (alive) {
      await load()
      stopping.value = false
    }
  }
}
function verify() {
  return action(async () => {
    if (!receipt.value) throw new Error('请先收集成果')
    const argumentsValue: unknown = JSON.parse(args.value)
    if (
      !Array.isArray(argumentsValue) ||
      !argumentsValue.every((item) => typeof item === 'string')
    )
      throw new Error('参数必须是 JSON 字符串数组')
    if (!command.value.trim()) throw new Error('请输入验证命令的可执行文件')
    verifying.value = true
    try {
      await validateDelegation({
        runId: props.runId,
        sessionId: props.sessionId,
        receiptId: receipt.value.id,
        criteria: {
          description: criterion.value,
          commands: [
            {
              executable: command.value.trim(),
              args: argumentsValue,
              timeoutMs: 120000,
            },
          ],
          requiresReview: requiresReview.value,
        },
        ...(reviewed.value
          ? { reviewedTreeDigest: receipt.value.resultTreeDigest }
          : {}),
      })
    } finally {
      verifying.value = false
    }
  })
}
function recover(inspect: boolean, verificationId?: string) {
  return action(async () => {
    const result = await recoverDelegation({
      id: props.delegationId,
      sessionId: props.sessionId,
      expectedRevision:
        (record.value?.currentRunId
          ? view.value?.runs[record.value.currentRunId]?.revision
          : run.value?.revision) ?? 0,
      inspect,
      ...(verificationId ? { verificationId } : {}),
    })
    if ('turns' in result)
      nativeHistory.value = result.turns.map((turn) => turn.text).join('\n\n')
  })
}
function makePreview() {
  return action(() =>
    integrateDelegation({
      runId: props.runId,
      sessionId: props.sessionId,
      action: 'preview',
    }),
  )
}
function apply() {
  const current = preview.value
  if (!current || !canApply.value) return
  return action(() =>
    integrateDelegation({
      runId: props.runId,
      sessionId: props.sessionId,
      action: 'apply',
      previewId: current.id,
      expectedRevision: current.revision,
      previewDigest: current.digest,
    }),
  )
}
onMounted(() => {
  void load()
  unsubscribe = onCoreEvent((input) => {
    if (!input || typeof input !== 'object') return
    const event = input as Record<string, unknown>
    if (event.run_id !== props.runId || event.event === 'delegation_output')
      return
    if (String(event.event).startsWith('delegation_')) {
      clearTimeout(timer)
      timer = setTimeout(() => void load(), 100)
    }
  })
})
onBeforeUnmount(() => {
  alive = false
  generation++
  clearTimeout(timer)
  unsubscribe()
})
</script>
<template>
  <Modal
    :open="true"
    title="外部智能体"
    :width="820"
    @update:open="!$event && emit('close')"
  >
    <div class="external-agent-details">
      <header class="external-facts">
        <div>
          <strong>{{
            record?.backend === 'codex' ? 'Codex' : 'Claude Code'
          }}</strong
          ><span v-if="receipt"> · {{ receipt.version }}</span>
          <p class="external-id">{{ delegationId }} / {{ runId }}</p>
        </div>
        <Button
          data-open-output
          size="sm"
          variant="outline"
          @click="showOutput = true"
          >查看输出</Button
        >
      </header>
      <div class="external-status">
        <span>{{ phases[run?.phase ?? ''] ?? '正在读取…' }}</span
        ><span :data-acceptance="acceptance">{{ acceptanceLabel }}</span>
      </div>
      <p v-if="error" role="alert" class="external-error">{{ error }}</p>
      <p v-if="run?.failureCode" class="external-note">
        {{ run.failureCode
        }}<Button
          v-if="
            run.failureCode.includes('AUTH') ||
            run.failureCode.includes('EXECUTOR')
          "
          size="sm"
          @click="emit('configure')"
          >打开执行器设置</Button
        >
      </p>
      <p v-if="run?.summary" class="external-note">
        执行器报告：{{ run.summary }}
      </p>
      <p class="external-path">成果目录 · {{ record?.cwd }}</p>
      <p v-if="run?.usage" class="external-note">
        输入 {{ run.usage.inputTokens ?? '未提供' }} / 输出
        {{ run.usage.outputTokens ?? '未提供' }} tokens · 费用{{
          run.usage.estimatedUsd === undefined
            ? '未提供'
            : `估算 $${run.usage.estimatedUsd}`
        }}
      </p>
      <p v-if="run?.phase === 'waiting_input'" class="external-note">
        请在当前聊天的提问卡片回答。<Button size="sm" @click="emit('close')"
          >返回提问</Button
        >
      </p>
      <div class="external-actions">
        <Button size="sm" :disabled="busy" @click="refresh">刷新</Button
        ><Button
          v-if="active || verifyingNow"
          data-stop
          size="sm"
          variant="danger"
          :disabled="stopping"
          @click="stop"
          >{{ stopping ? '正在停止…' : '停止本轮' }}</Button
        ><Button
          v-if="
            record?.availability === 'needs_recovery' || record?.dispatchPaused
          "
          size="sm"
          :disabled="busy"
          @click="recover(true)"
          >查看原生历史</Button
        ><Button
          v-if="
            record?.availability === 'needs_recovery' || record?.dispatchPaused
          "
          size="sm"
          :disabled="busy"
          @click="recover(false)"
          >恢复调度</Button
        ><Button
          v-for="id in delivery?.verificationRecoveryIds ?? []"
          :key="id"
          size="sm"
          :disabled="busy"
          @click="recover(false, id)"
          >确认验证进程已停止</Button
        >
      </div>
      <pre v-if="nativeHistory" class="external-code">{{ nativeHistory }}</pre>
      <section v-if="mutable" class="external-section">
        <h3>继续这个外部会话</h3>
        <textarea
          v-model="followup"
          data-followup
          :disabled="busy"
          aria-label="给外部智能体的后续消息"
          placeholder="补充要求或请求修正"
          maxlength="32768"
        />
        <div class="external-actions">
          <Button
            data-send
            size="sm"
            variant="primary"
            :disabled="busy || !followup.trim()"
            @click="send('queue')"
            >{{ active ? '排队发送' : '发送后续消息' }}</Button
          ><Button
            v-if="steer"
            data-steer
            size="sm"
            variant="outline"
            :disabled="busy || !followup.trim()"
            @click="send('steer')"
            >调整当前轮次</Button
          >
        </div>
        <p class="external-note">
          排队消息在当前轮结束后执行，新轮次会生成新任务记录。
        </p>
      </section>
      <section class="external-section">
        <h3>成果与验收</h3>
        <Button
          v-if="!receipt && !active"
          size="sm"
          :disabled="busy"
          @click="action(() => collectDelegation({ runId, sessionId }))"
          >收集成果</Button
        ><template v-if="receipt"
          ><p class="external-id">结果树 · {{ receipt.resultTreeDigest }}</p>
          <ul class="external-files">
            <li v-for="file in receipt.changedFiles" :key="file.path">
              {{ file.status }} · {{ file.path
              }}{{ file.binary ? ' · 二进制' : '' }}
            </li>
          </ul>
          <details v-if="delivery?.patch">
            <summary>查看差异</summary>
            <pre class="external-code">{{ delivery.patch.content }}</pre>
            <p v-if="delivery.patch.truncated" class="external-note">
              差异已截断，请在成果目录查看完整改动。
            </p>
          </details>
          <p
            v-if="delivery?.patchError || delivery?.previewError"
            class="external-error"
          >
            {{ delivery.patchError || delivery.previewError }}
          </p>
          <p v-if="receipt.excluded.length" class="external-note">
            排除 {{ receipt.excluded.length }} 项：{{
              receipt.excluded
                .map((item) => `${item.path} (${item.reason})`)
                .join('、')
            }}
          </p>
          <p v-if="delivery?.acceptance?.reason" class="external-note">
            {{ delivery.acceptance.reason }}
          </p>
          <ul
            v-if="delivery?.acceptance?.evidence.length"
            class="external-files"
          >
            <li
              v-for="(evidence, index) in delivery.acceptance.evidence"
              :key="index"
            >
              {{
                evidence.source === 'host-verified' ? '宿主验证' : '执行器自报'
              }}
              · exit {{ evidence.exitCode ?? '未知' }} ·
              {{ evidence.argv.join(' ') }}
              <p class="external-id">
                {{ evidence.cwd }} · {{ evidence.treeDigest }}
              </p>
            </li>
          </ul>
          <details>
            <summary>独立验证当前成果</summary>
            <div class="external-form">
              <label
                >验收要求<input v-model="criterion" :disabled="busy" /></label
              ><label
                >可执行文件<input
                  v-model="command"
                  :disabled="busy"
                  placeholder="例如 npm 或 /usr/bin/python3" /></label
              ><label
                >参数（JSON 数组）<input
                  v-model="args"
                  :disabled="busy"
                  spellcheck="false" /></label
              ><label class="external-check"
                ><input
                  v-model="requiresReview"
                  type="checkbox"
                  :disabled="busy"
                />需要人工审查</label
              ><label class="external-check"
                ><input
                  v-model="reviewed"
                  type="checkbox"
                  :disabled="busy"
                />我已审查上面的结果树</label
              ><Button
                size="sm"
                variant="outline"
                :disabled="busy || active"
                @click="verify"
                >{{ verifying ? '验证中…' : '运行宿主验证' }}</Button
              >
            </div>
          </details>
          <div class="external-actions">
            <Button
              size="sm"
              variant="outline"
              :disabled="busy || acceptance !== 'passed'"
              @click="makePreview"
              >生成整合预览</Button
            >
          </div>
        </template>
      </section>
      <section v-if="preview" class="external-section">
        <h3>
          整合预览 ·
          {{
            preview.status === 'applied'
              ? '已应用'
              : preview.status === 'ready'
                ? '待应用'
                : '需要处理'
          }}
        </h3>
        <p class="external-path">保留的预览目录 · {{ preview.cwd }}</p>
        <p class="external-path">目标工作区 · {{ preview.target?.cwd }}</p>
        <p class="external-id">
          原 HEAD · {{ preview.target?.head ?? '无' }} · 原索引
          {{ preview.target?.indexDigest ?? '无' }}
        </p>
        <p class="external-id">
          预览版本 {{ preview.revision }} · 整合结果树 {{ preview.treeDigest }}
        </p>
        <p v-if="preview.verificationId" class="external-id">
          预览验证 · {{ preview.verificationId }}
        </p>
        <ul class="external-files">
          <li v-for="operation in preview.operations" :key="operation.path">
            {{ operation.path }}
            <p class="external-id">
              {{ operation.before?.sha256 ?? '新增' }} →
              {{ operation.after?.sha256 ?? '删除' }}
            </p>
          </li>
        </ul>

        <p v-if="preview.reason" class="external-note">{{ preview.reason }}</p>
        <ul class="external-files">
          <li v-for="path in preview.conflicts" :key="path">
            冲突 · {{ path }}
          </li>
        </ul>
        <label
          v-if="
            record?.owner.requiredForGoal && !active && acceptance !== 'passed'
          "
          class="external-form"
        >
          明确接受本项失败的处置理由（填写后关闭会话，Goal 才能将其视为已处置）
          <input
            v-model="failureDisposition"
            aria-label="必需任务失败处置理由"
            :disabled="busy || !mutable"
          />
        </label>
        <p v-if="run?.goalFailureDisposition" class="external-note">
          用户已处置失败：{{ run.goalFailureDisposition.reason }}
        </p>
        <Button
          v-if="canApply"
          data-apply
          size="sm"
          variant="primary"
          :disabled="busy"
          @click="apply"
          >应用此预览到原工作区</Button
        >
        <p class="external-note">
          预览和双方成果目录会保留。应用前会重新检查原工作区、预览版本和验收证据。
        </p>
      </section>
      <p v-if="record?.availability === 'closed'" class="external-note">
        外部会话已关闭，成果目录保留。
      </p>
    </div>
    <template #footer
      ><Button
        v-if="record?.availability !== 'closed'"
        size="sm"
        :disabled="busy"
        @click="
          action(() =>
            closeDelegation({
              id: delegationId,
              sessionId,
              ...(failureDisposition.trim()
                ? { failureDisposition: failureDisposition.trim() }
                : {}),
            }),
          )
        "
        >关闭外部会话</Button
      ><Button size="sm" @click="emit('close')">返回聊天</Button></template
    >
  </Modal>
  <TaskOutputDialog
    v-if="showOutput"
    :task-id="runId"
    :session-id="sessionId"
    :label="record?.backend ?? '外部智能体'"
    kind="external-agent"
    :live="active"
    @close="showOutput = false"
  />
</template>
<style scoped>
.external-agent-details {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  max-height: 65vh;
  overflow: auto;
  min-width: 0;
  color: rgb(var(--label-primary));
  font-size: var(--fs-xs);
  text-wrap: pretty;
}
.external-facts,
.external-status,
.external-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.external-actions {
  justify-content: flex-start;
}
.external-status {
  padding: var(--space-2) var(--space-3);
  background: rgb(var(--bg-layer-1));
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-row);
}
.external-status [data-acceptance='passed'] {
  color: rgb(var(--state-ok-label));
}
.external-section {
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-l2);
}
h3 {
  margin: 0 0 var(--space-2);
  font-size: var(--fs-s);
}
p {
  margin: var(--space-1) 0;
}
.external-note {
  color: rgb(var(--label-secondary));
  overflow-wrap: anywhere;
}
.external-error {
  color: rgb(var(--state-error-label));
  overflow-wrap: anywhere;
}
.external-path,
.external-id,
.external-code {
  font: var(--font-code-small);
  overflow-wrap: anywhere;
  color: rgb(var(--label-tertiary));
}
.external-code {
  white-space: pre-wrap;
  max-height: 240px;
  overflow: auto;
}
.external-files {
  padding-left: var(--space-4);
  overflow-wrap: anywhere;
}
.external-form {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3) 0;
}
.external-form label {
  display: grid;
  gap: var(--space-1);
}
.external-form .external-check {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
input:not([type='checkbox']),
textarea {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  padding: var(--space-2);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-row);
  background: rgb(var(--bg-layer-3));
  color: rgb(var(--label-primary));
  font: inherit;
}
textarea {
  min-height: 84px;
  resize: vertical;
}
input:focus-visible,
textarea:focus-visible {
  outline: 2px solid rgb(var(--focus-ring) / 0.5);
  outline-offset: 1px;
}
summary {
  cursor: pointer;
}
</style>
