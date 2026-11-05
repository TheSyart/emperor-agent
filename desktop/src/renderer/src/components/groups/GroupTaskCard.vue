<script setup lang="ts">
/**
 * GroupTaskCard — the current GroupTask fact in the conversation. Simple
 * assignments keep the original card; CG-02 adds an owner, blocked
 * dependencies, candidate artifacts and host-recorded checks. A submission
 * is not done until the user accepts its exact artifact revision.
 *
 * Props: task, ownerName, waitingDependencies.
 * Emits: confirm(approve), accept({ artifactRevision, checks }).
 */
import { computed, ref, watch } from 'vue'
import Button from '../ui/Button.vue'
import LinkButton from '../ui/LinkButton.vue'
import { ACCESS_LABELS, TASK_STATE_LABELS, type GroupTask } from './groupModel'

const props = withDefaults(
  defineProps<{
    task: GroupTask
    ownerName: string
    waitingDependencies?: string[]
  }>(),
  { waitingDependencies: () => [] },
)
const emit = defineEmits<{
  confirm: [approve: boolean]
  accept: [
    input: {
      artifactRevision: string
      checks: NonNullable<GroupTask['checks']>
    },
  ]
}>()

const waiting = computed(() => props.task.state === 'waiting_user')
const submitted = computed(() => props.task.state === 'submitted')
const held = computed(() => props.task.hold === 'task_relay')
const blocked = computed(
  () => props.task.state === 'queued' && props.waitingDependencies.length > 0,
)
const artifact = computed(() => props.task.artifacts?.at(-1))
const checks = computed(() => props.task.checks ?? [])
const acceptable = computed(
  () =>
    submitted.value &&
    artifact.value !== undefined &&
    checks.value.length > 0 &&
    checks.value.every(
      (check) =>
        check.passed &&
        check.artifactRevision === artifact.value!.revision &&
        check.evidenceRef.trim().length > 0,
    ),
)
const stateLabel = computed(() =>
  blocked.value ? '等待前置' : TASK_STATE_LABELS[props.task.state],
)
const tone = computed(() => {
  switch (props.task.state) {
    case 'running':
      return 'run'
    case 'done':
      return 'done'
    case 'waiting_user':
    case 'submitted':
      return 'ask'
    case 'failed':
    case 'cancelled':
      return 'off'
    default:
      return 'queued'
  }
})

const showEvidence = ref(false)
const showArtifact = ref(false)
watch(
  () => [props.task.taskId, props.task.state, artifact.value?.revision],
  () => {
    showEvidence.value = false
    showArtifact.value = false
  },
)

function artifactName(ref: string): string {
  const name = ref.split('/').at(-1) || ref
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

function accept(): void {
  if (!acceptable.value || !artifact.value) return
  emit('accept', {
    artifactRevision: artifact.value.revision,
    checks: checks.value.map((check) => ({ ...check })),
  })
}
</script>

<template>
  <section class="task" data-task-card :data-state="task.state">
    <header class="head">
      <b class="title">{{ task.title }}</b>
      <span class="state" data-task-state :data-tone="tone">{{
        stateLabel
      }}</span>
    </header>
    <dl class="kv">
      <dt>交付</dt>
      <dd>{{ task.deliverable }}</dd>
      <dt>负责人</dt>
      <dd data-task-owner>{{ ownerName }}</dd>
      <template v-if="task.basis">
        <dt>依据</dt>
        <dd>{{ task.basis }}</dd>
      </template>
      <template v-if="blocked">
        <dt>前置</dt>
        <dd class="dependency" data-task-dependencies>
          {{ waitingDependencies.join('、') }} · 尚未完成，暂不可接单
        </dd>
      </template>
      <template v-if="artifact">
        <dt>成果</dt>
        <dd>
          <LinkButton data-task-artifact @click="showArtifact = !showArtifact">
            {{ artifactName(artifact.ref) }}</LinkButton
          ><span class="revision">{{ artifact.revision }}</span>
        </dd>
      </template>
      <dt>权限</dt>
      <dd>{{ ACCESS_LABELS[task.access] }}</dd>
    </dl>
    <p v-if="submitted" class="candidate">候选成果，确认前不算完成。</p>
    <div
      v-if="showArtifact && artifact"
      class="detail"
      data-task-artifact-detail
    >
      <span>公开成果 · {{ artifact.revision }}</span>
      <code>{{ artifact.ref }}</code>
    </div>
    <div v-if="showEvidence" class="detail" data-task-evidence-list>
      <div v-for="check in checks" :key="check.evidenceRef" class="check">
        <span :data-passed="check.passed">{{ check.passed ? '✓' : '×' }}</span>
        <span>{{ check.passed ? '检查通过' : '检查未通过' }}</span>
        <code>{{ check.evidenceRef }}</code>
      </div>
    </div>
    <div v-if="task.state === 'done' && checks.length" class="accepted">
      <span>✓</span>
      <span
        >{{ checks.length }} 项检查依据通过 · 成果
        {{ artifact?.revision }}</span
      >
    </div>
    <div v-if="submitted" class="actions" data-task-acceptance>
      <Button
        size="sm"
        variant="secondary"
        :disabled="!checks.length"
        @click="showEvidence = !showEvidence"
        >检查依据</Button
      >
      <Button
        size="sm"
        variant="primary"
        :disabled="!acceptable"
        data-task-accept
        @click="accept"
        >确认完成</Button
      >
    </div>
    <div v-if="waiting" class="confirm" data-task-confirm>
      <p v-if="held" class="note">
        这一轮交办的次数多了，这项先不开始：同意就接着做，不同意就取消；也可以在下面回复「继续」。
      </p>
      <p v-else class="note">
        要改项目代码：同意后它在隔离副本里改，改动先给你看，你确认后才合进项目。
      </p>
      <div class="actions">
        <Button size="sm" variant="secondary" @click="emit('confirm', false)"
          >不同意</Button
        >
        <Button size="sm" variant="primary" @click="emit('confirm', true)"
          >同意</Button
        >
      </div>
    </div>
  </section>
</template>

<style scoped>
.task {
  display: grid;
  gap: var(--space-1-5);
  max-width: 560px;
  margin-top: var(--space-1);
  padding: var(--space-2-5) var(--space-3-5);
  border-radius: var(--r-md);
  background: rgb(var(--surface-base));
  box-shadow: 0 0 0 0.5px var(--hairline);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}
.head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}
.title {
  min-width: 0;
  font-weight: var(--weight-semibold);
}
.state {
  flex: none;
  margin-left: auto;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
}
.state[data-tone='run'] {
  color: rgb(var(--info));
}
.state[data-tone='done'] {
  color: rgb(var(--ok));
}
.state[data-tone='ask'] {
  color: rgb(var(--attention));
}
.kv {
  display: grid;
  grid-template-columns: 52px minmax(0, 1fr);
  gap: var(--space-1) var(--space-2-5);
  margin: 0;
}
.kv dt {
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
}
.kv dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}
.dependency,
.candidate {
  color: rgb(var(--text-2));
}
.revision {
  margin-left: var(--space-1-5);
  color: rgb(var(--text-3));
  font-family: var(--font-mono);
  font-size: var(--fs-xxs);
}
.candidate {
  margin: 0;
  padding-top: var(--space-2);
  box-shadow: inset 0 0.5px 0 var(--hairline);
  font-size: var(--fs-xxs);
}
.detail {
  display: grid;
  gap: var(--space-1);
  padding: var(--space-2);
  border-radius: var(--r-sm);
  background: rgb(var(--surface-sunken));
  color: rgb(var(--text-2));
  font-size: var(--fs-xxs);
}
.detail code {
  overflow-wrap: anywhere;
  color: rgb(var(--text-3));
  font-family: var(--font-mono);
  font-size: var(--fs-xxs);
}
.check {
  display: flex;
  align-items: flex-start;
  gap: var(--space-1-5);
}
.check > span[data-passed='true'],
.accepted {
  color: rgb(var(--ok));
}
.check code {
  margin-left: auto;
}
.accepted {
  display: flex;
  gap: var(--space-1-5);
  font-size: var(--fs-xxs);
}
.confirm {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding-top: var(--space-2);
  box-shadow: inset 0 0.5px 0 var(--hairline);
}
.note {
  flex: 1 1 240px;
  margin: 0;
  color: rgb(var(--text-2));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-1-5);
}
</style>
