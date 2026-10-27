<script setup lang="ts">
/**
 * NewGroupDialog — 新建群聊 (GRP-08): start from a template (评审, 正反方,
 * 调研写作) or a blank group; a template names the group, writes its
 * announcement and ticks the contacts made from its roles (a role nobody
 * was made from is listed, with a way to create one). The members, the
 * moderator (Emperor when it is in), the announcement and the
 * collaboration can be changed before 「建群」; the collaboration starts
 * at 设置 › 群聊's default and is sent only when changed, so the loop
 * guard and the rest follow 设置 › 群聊 as well (D14). The new group opens.
 *
 * Props: open (v-model:open).
 */
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { Contact } from '@emperor/core/api'
import { core } from '../../api/http'
import { useAppContext } from '../../composables/useAppContext'
import { contactAvatarProps } from '../contacts/contactAvatar'
import { useContactDirectory } from '../contacts/contactDirectory'
import Avatar from '../ui/Avatar.vue'
import Button from '../ui/Button.vue'
import Checkbox from '../ui/Checkbox.vue'
import Field from '../ui/Field.vue'
import LinkButton from '../ui/LinkButton.vue'
import Modal from '../ui/Modal.vue'
import Segmented from '../ui/Segmented.vue'
import Select from '../ui/Select.vue'
import Surface from '../ui/Surface.vue'
import TextArea from '../ui/TextArea.vue'
import TextField from '../ui/TextField.vue'
import {
  EMPEROR_ID,
  GROUP_MEMBER_LIMIT,
  GROUP_TEMPLATES,
  GROUP_TITLE_LIMIT,
  templateMembers,
  type GroupTemplate,
} from './newGroupModel'

type Collaboration = 'autonomous' | 'moderated'

const open = defineModel<boolean>('open', { default: false })
const router = useRouter()
const ctx = useAppContext()
const directory = useContactDirectory()

const template = ref<GroupTemplate['id'] | 'blank'>('blank')
const title = ref('')
const charter = ref('')
const picked = ref<string[]>([])
const moderator = ref('')
const collaboration = ref<Collaboration>('autonomous')
const defaultCollaboration = ref<Collaboration>('autonomous')
const missing = ref<string[]>([])
const creating = ref(false)

const contacts = computed<readonly Contact[]>(() => directory.contacts.value)

const CARDS = [
  ...GROUP_TEMPLATES.map((item) => ({
    id: item.id,
    name: item.name,
    description: item.description,
  })),
  { id: 'blank' as const, name: '空白', description: '自己挑成员、写公告' },
]

const COLLABORATION_OPTIONS = [
  { value: 'autonomous' as const, label: '自主' },
  { value: 'moderated' as const, label: '主持人审核' },
]

function choose(id: GroupTemplate['id'] | 'blank'): void {
  template.value = id
  const found = GROUP_TEMPLATES.find((item) => item.id === id)
  if (!found) {
    title.value = ''
    charter.value = ''
    picked.value = contacts.value.some((contact) => contact.id === EMPEROR_ID)
      ? [EMPEROR_ID]
      : []
    missing.value = []
  } else {
    const chosen = templateMembers(found, contacts.value)
    title.value = found.name
    charter.value = found.charter
    picked.value = chosen.members
    missing.value = chosen.missing
  }
  moderator.value = picked.value.includes(EMPEROR_ID) ? EMPEROR_ID : ''
}

async function prepare(): Promise<void> {
  directory.ensure()
  try {
    const defaults = await core('groups.defaults')
    defaultCollaboration.value = defaults.collaboration
  } catch {
    defaultCollaboration.value = 'autonomous'
  }
  collaboration.value = defaultCollaboration.value
}

watch(
  open,
  (value) => {
    if (!value) return
    creating.value = false
    void prepare()
    choose('blank')
  },
  { immediate: true },
)
// The contacts may arrive after the dialog opened.
watch(
  () => directory.contacts.value.length,
  () => {
    if (open.value && !title.value && template.value === 'blank')
      choose('blank')
  },
)

function toggle(id: string, on: boolean): void {
  if (on && !picked.value.includes(id)) picked.value = [...picked.value, id]
  if (!on) {
    picked.value = picked.value.filter((item) => item !== id)
    if (moderator.value === id) moderator.value = ''
  }
}

const members = computed(() =>
  contacts.value
    .filter((contact) => picked.value.includes(contact.id))
    .map((contact) => contact.id),
)
const moderatorOptions = computed(() => [
  { value: '', label: '没有主持人' },
  ...contacts.value
    .filter((contact) => picked.value.includes(contact.id))
    .map((contact) => ({ value: contact.id, label: contact.name })),
])
const tooMany = computed(() => members.value.length > GROUP_MEMBER_LIMIT)
const ready = computed(
  () =>
    Boolean(title.value.trim()) &&
    members.value.length > 0 &&
    !tooMany.value &&
    !creating.value,
)

function newContact(): void {
  open.value = false
  void router.push({ name: 'contact-new' }).catch(() => undefined)
}

async function create(): Promise<void> {
  if (!ready.value) return
  creating.value = true
  try {
    const group = await core('groups.create', {
      title: title.value.trim(),
      members: members.value,
      moderator:
        moderator.value && members.value.includes(moderator.value)
          ? moderator.value
          : null,
      ...(charter.value.trim() ? { charter: charter.value.trim() } : {}),
      ...(collaboration.value !== defaultCollaboration.value
        ? { settings: { collaboration: collaboration.value } }
        : {}),
    })
    open.value = false
    await router.push({ name: 'group', params: { groupId: group.id } })
  } catch (error) {
    ctx.showError(error, '群没有建成')
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <Modal v-model:open="open" title="新建群聊" :width="640">
    <div class="new-group" data-new-group>
      <div class="templates" role="group" aria-label="模板">
        <Surface
          v-for="card in CARDS"
          :key="card.id"
          as="button"
          pad="sm"
          interactive
          class="template"
          :aria-pressed="template === card.id"
          :data-template="card.id"
          @click="choose(card.id)"
        >
          <b>{{ card.name }}</b>
          <span>{{ card.description }}</span>
        </Surface>
      </div>

      <Field label="群名" data-new-group-title>
        <TextField
          v-model="title"
          :maxlength="GROUP_TITLE_LIMIT"
          placeholder="例如：0.3 方案评审"
          data-autofocus
        />
      </Field>

      <div class="picker">
        <span class="picker-label">成员</span>
        <ul class="people">
          <li
            v-for="contact in contacts"
            :key="contact.id"
            class="person"
            :data-pick-member="contact.id"
          >
            <Checkbox
              :model-value="picked.includes(contact.id)"
              :aria-label="contact.name"
              @update:model-value="toggle(contact.id, $event)"
            >
              <span class="person-line">
                <Avatar
                  v-bind="contactAvatarProps(contact.avatar, contact.name)"
                  :size="20"
                />
                <span class="person-name">{{ contact.name }}</span>
                <span class="person-intro">{{
                  contact.kind === 'external' ? '外部' : contact.intro
                }}</span>
              </span>
            </Checkbox>
          </li>
        </ul>
        <p v-if="missing.length" class="missing">
          还没有：{{ missing.join('、') }}
          <LinkButton @click="newContact">去新建联系人</LinkButton>
        </p>
        <p v-if="tooMany" class="missing">
          一个群最多 {{ GROUP_MEMBER_LIMIT }} 位成员
        </p>
      </div>

      <div class="pair">
        <Field label="主持人">
          <Select
            v-model="moderator"
            :options="moderatorOptions"
            size="sm"
            block
          />
        </Field>
        <Field label="协作方式" hint="默认值在「设置 › 群聊」">
          <Segmented
            v-model="collaboration"
            :options="COLLABORATION_OPTIONS"
            aria-label="协作方式"
          />
        </Field>
      </div>

      <Field
        label="群公告"
        hint="每位成员发言前都会读到"
        data-new-group-charter
      >
        <TextArea
          v-model="charter"
          :min-rows="3"
          :max-rows="8"
          placeholder="目标、约束"
        />
      </Field>
    </div>
    <template #footer>
      <Button @click="open = false">取消</Button>
      <Button
        variant="primary"
        :disabled="!ready"
        :loading="creating"
        @click="create"
        >建群</Button
      >
    </template>
  </Modal>
</template>

<style scoped>
.new-group {
  display: grid;
  gap: var(--space-3-5);
}

.templates {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-2);
}

.template {
  display: grid;
  align-content: start;
  gap: var(--space-0-5);
  min-height: 72px;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  text-align: left;
}

.template b {
  color: rgb(var(--text-1));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: var(--weight-semibold);
}

.template[aria-pressed='true'] {
  background: rgb(var(--accent-soft));
  box-shadow: inset 0 0 0 1px rgb(var(--accent));
}

.picker {
  display: grid;
  gap: var(--space-1-5);
}

.picker-label {
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: var(--weight-medium);
}

.people {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-1) var(--space-3);
  max-height: 220px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.person-line {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  min-width: 0;
}

.person-name {
  font-size: var(--fs-xs);
}

.person-intro {
  overflow: hidden;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.missing {
  margin: 0;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.pair {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}
</style>
