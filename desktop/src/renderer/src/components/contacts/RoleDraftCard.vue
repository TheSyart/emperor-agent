<script setup lang="ts">
/**
 * The role creator's user decision card (CG-CT-01). The model supplied an
 * unsaved, Core-validated draft in tool-result metadata; only these buttons
 * call contacts.create/update. Trial uses the same unsaved ContactDraftInput
 * as the advanced editor, and 继续调整 only fills the composer.
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { Contact, ContactsListing } from '@emperor/core/api'
import { core } from '../../api/http'
import {
  contactDraftMatches,
  contactRoleDraftMeta,
} from '../../conversation/contactRoleDraft'
import type { ToolChatNode } from '../../conversation/types'
import Avatar from '../ui/Avatar.vue'
import Button from '../ui/Button.vue'
import Notice from '../ui/Notice.vue'
import { contactAvatarProps } from './contactAvatar'
import { failureText } from './contactEditorModel'
import TrialBench from './TrialBench.vue'

const props = defineProps<{ node: ToolChatNode }>()
const router = useRouter()
const meta = computed(() => contactRoleDraftMeta(props.node.data.result?.meta))
const draft = computed(() => meta.value?.draft ?? null)
const trialOpen = ref(false)
const busy = ref(false)
const checking = ref(false)
const savedId = ref('')
const savedName = ref('')
const error = ref('')

const avatar = computed(() =>
  contactAvatarProps(
    draft.value?.avatar ?? { kind: 'library', id: 'AV-13-1' },
    draft.value?.name ?? '联系人',
  ),
)
const confirmLabel = computed(() =>
  meta.value?.action === 'edit' ? '确认调整' : '确认创建',
)

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** A create draft already present after a retry/reload is not created again. */
async function existing(): Promise<Contact | null> {
  const current = meta.value
  if (current?.action !== 'create') return null
  const listing = (await core('contacts.list')) as ContactsListing
  return (
    listing.contacts.find((contact) =>
      contactDraftMatches(current.draft, contact),
    ) ?? null
  )
}

async function checkExisting(): Promise<void> {
  if (meta.value?.action !== 'create' || savedId.value || checking.value) return
  checking.value = true
  try {
    const found = await existing()
    if (found) {
      savedId.value = found.id
      savedName.value = found.name
    }
  } catch {
    // Confirmation repeats this check and reports any failure there.
  } finally {
    checking.value = false
  }
}
onMounted(() => void checkExisting())

function adjust(): void {
  const current = draft.value
  if (!current) return
  window.dispatchEvent(
    new CustomEvent('emperor:set-composer-draft', {
      detail: {
        text: `请继续调整「${current.name}」的联系人草稿：`,
      },
    }),
  )
}

async function save(): Promise<void> {
  const current = meta.value
  if (!current || busy.value || savedId.value) return
  busy.value = true
  error.value = ''
  try {
    if (current.action === 'create') {
      const found = await existing()
      if (found) {
        savedId.value = found.id
        savedName.value = found.name
        return
      }
      const listing = await core('contacts.list')
      if (
        listing.contacts.some(
          (contact) =>
            contact.name.toLowerCase() === current.draft.name.toLowerCase(),
        )
      ) {
        error.value = `已经有同名联系人「${current.draft.name}」，没有重复创建。请继续调整草稿。`
        return
      }
      const saved = await core('contacts.create', plain(current.draft))
      savedId.value = saved.id
      savedName.value = saved.name
      return
    }
    if (!current.patch) throw new Error('草稿缺少修改内容，请让创建师重新生成')
    const saved = await core('contacts.update', {
      id: current.targetId!,
      patch: plain(current.patch),
    })
    savedId.value = saved.id
    savedName.value = saved.name
  } catch (failure) {
    error.value = failureText(failure)
  } finally {
    busy.value = false
  }
}

function openSaved(): void {
  if (!savedId.value) return
  void router
    .push({ name: 'contact', params: { id: savedId.value } })
    .catch(() => undefined)
}
</script>

<template>
  <section
    v-if="meta && draft"
    class="role-draft"
    data-role-draft-card
    :data-action="meta.action"
    aria-label="联系人草稿确认"
  >
    <header class="head">
      <Avatar v-bind="avatar" :size="40" />
      <div class="heading">
        <h3>{{ savedId ? `已保存「${savedName}」` : draft.name }}</h3>
        <p>
          {{ savedId ? '联系人现在可以发消息或加入群聊。' : '草稿尚未保存' }}
        </p>
      </div>
      <span class="badge">{{
        meta.action === 'edit' ? '调整' : '新联系人'
      }}</span>
    </header>

    <div class="layout">
      <div class="summary">
        <p v-if="draft.intro" class="intro">{{ draft.intro }}</p>
        <dl>
          <div>
            <dt>职责</dt>
            <dd>{{ draft.role.mission || '—' }}</dd>
          </div>
          <div>
            <dt>交付</dt>
            <dd>{{ draft.role.deliverable || '—' }}</dd>
          </div>
          <div v-if="draft.role.boundaries">
            <dt>边界</dt>
            <dd>{{ draft.role.boundaries }}</dd>
          </div>
        </dl>
      </div>
      <aside class="capabilities" aria-label="草稿能力">
        <div>
          <span class="label">Skills</span>
          <p v-if="draft.skills?.length">
            {{ draft.skills.map((skill) => skill.name).join('、') }}
          </p>
          <p v-else class="muted">未选择</p>
        </div>
        <div>
          <span class="label">MCP 服务</span>
          <p v-if="draft.mcp?.length">
            {{ draft.mcp.map((server) => server.serverId).join('、') }}
          </p>
          <p v-else class="muted">未选择</p>
          <small v-if="draft.mcp?.length">
            已整选当前工具；以后新增的工具不会自动授权。
          </small>
        </div>
        <div>
          <span class="label">知识</span>
          <p>{{ draft.knowledge?.length ?? 0 }} 条</p>
        </div>
      </aside>
    </div>

    <Notice v-if="error" tone="error" title="没有保存" :description="error" />

    <TrialBench
      v-if="trialOpen && !savedId"
      class="trial"
      :draft="draft"
      :default-task="draft.role.trialTask ?? ''"
    />

    <footer class="actions">
      <template v-if="savedId">
        <Button size="sm" variant="primary" @click="openSaved"
          >查看联系人</Button
        >
      </template>
      <template v-else>
        <Button size="sm" variant="secondary" @click="trialOpen = !trialOpen">
          {{ trialOpen ? '收起试用' : '先试用' }}
        </Button>
        <Button size="sm" variant="secondary" @click="adjust">继续调整</Button>
        <Button
          size="sm"
          variant="primary"
          :loading="busy"
          :disabled="busy || checking"
          @click="save"
          >{{ confirmLabel }}</Button
        >
      </template>
    </footer>
  </section>
</template>

<style scoped>
.role-draft {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-4);
  border-radius: var(--r-lg);
  background: rgb(var(--surface-raised));
  box-shadow: inset 0 0 0 0.5px var(--stroke-2);
}
.head {
  display: flex;
  align-items: center;
  gap: var(--space-2-5);
  min-width: 0;
}
.heading {
  flex: 1;
  min-width: 0;
}
.heading h3,
.heading p,
.intro,
.capabilities p {
  margin: 0;
}
.heading h3 {
  overflow: hidden;
  color: rgb(var(--text-1));
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: var(--weight-semibold);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.heading p {
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}
.badge {
  flex: none;
  padding: 2px 8px;
  border-radius: var(--r-full);
  background: rgb(var(--accent-soft));
  color: rgb(var(--text-link));
  font-size: var(--fs-xxxs);
}
.layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(180px, 0.42fr);
  gap: var(--space-4);
}
.summary,
.capabilities {
  min-width: 0;
}
.intro {
  margin-bottom: var(--space-3);
  color: rgb(var(--text-2));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}
dl {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
}
dl > div {
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr);
  gap: var(--space-2);
}
dt,
.label {
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}
dd {
  margin: 0;
  color: rgb(var(--text-1));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  white-space: pre-wrap;
}
.capabilities {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding-left: var(--space-4);
  box-shadow: inset 0.5px 0 0 var(--hairline);
}
.capabilities > div {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.capabilities p {
  color: rgb(var(--text-1));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  overflow-wrap: anywhere;
}
.capabilities small {
  color: rgb(var(--text-3));
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
}
.capabilities .muted {
  color: rgb(var(--text-3));
}
.trial {
  padding-top: var(--space-3);
  box-shadow: inset 0 0.5px 0 var(--hairline);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}
@media (max-width: 560px) {
  .layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .capabilities {
    padding-top: var(--space-3);
    padding-left: 0;
    box-shadow: inset 0 0.5px 0 var(--hairline);
  }
}
</style>
