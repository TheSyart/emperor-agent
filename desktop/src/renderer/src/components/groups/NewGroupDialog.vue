<script setup lang="ts">
/**
 * NewGroupDialog — 新建群聊 (GRP-08): start from a template (评审, 正反方,
 * 调研写作) or a blank group; a template names the group, writes its
 * announcement and ticks the contacts made from its roles (a role nobody
 * was made from is listed, with a way to create one). The members and
 * announcement can be changed before 「建群」. Emperor is always built in;
 * only the other members are picked here and Core adds Emperor on creation.
 * Every group coordinates autonomously; there are no collaboration, project
 * or Git setup choices. Each member works in its own directory and the new
 * group opens.
 *
 * Props: open (v-model:open).
 */
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ROLE_CREATOR_CONTACT_ID } from '@emperor/core/runtime-contract'
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

const open = defineModel<boolean>('open', { default: false })
const router = useRouter()
const ctx = useAppContext()
const directory = useContactDirectory()

const template = ref<GroupTemplate['id'] | 'blank'>('blank')
const title = ref('')
const charter = ref('')
const picked = ref<string[]>([])
const missing = ref<string[]>([])
const creating = ref(false)

const contacts = computed<readonly Contact[]>(() =>
  directory.contacts.value.filter(
    (contact) =>
      contact.id !== ROLE_CREATOR_CONTACT_ID && contact.id !== EMPEROR_ID,
  ),
)

const CARDS = [
  ...GROUP_TEMPLATES.map((item) => ({
    id: item.id,
    name: item.name,
    description: item.description,
  })),
  { id: 'blank' as const, name: '空白', description: '自己挑成员、写公告' },
]

function choose(id: GroupTemplate['id'] | 'blank'): void {
  template.value = id
  const found = GROUP_TEMPLATES.find((item) => item.id === id)
  if (!found) {
    title.value = ''
    charter.value = ''
    picked.value = []
    missing.value = []
  } else {
    const chosen = templateMembers(found, contacts.value)
    title.value = found.name
    charter.value = found.charter
    picked.value = chosen.members
    missing.value = chosen.missing
  }
}

watch(
  open,
  (value) => {
    if (!value) return
    creating.value = false
    directory.ensure()
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
  }
}

const members = computed(() =>
  contacts.value
    .filter((contact) => picked.value.includes(contact.id))
    .map((contact) => contact.id),
)
const tooMany = computed(() => members.value.length + 1 > GROUP_MEMBER_LIMIT)
const ready = computed(
  () => Boolean(title.value.trim()) && !tooMany.value && !creating.value,
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
      ...(charter.value.trim() ? { charter: charter.value.trim() } : {}),
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
      <section class="form-section" data-group-section="name">
        <div class="form-section-head">
          <h3>1. 群名称</h3>
          <span>可用模板快速开始</span>
        </div>
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
      </section>

      <section class="form-section" data-group-section="members">
        <div class="form-section-head">
          <h3>2. 成员</h3>
          <span
            >已选 {{ members.length }} 位其他成员 · 共
            {{ members.length + 1 }} 人（含 Emperor）</span
          >
        </div>
        <div class="picker">
          <div data-fixed-emperor>
            <div class="fixed-member">
              <Avatar
                kind="mascot"
                id="crown-head"
                label="Emperor"
                :size="28"
              />
              <div class="fixed-copy">
                <b>Emperor</b>
                <span>统筹、拆解任务，在群里主持讨论</span>
              </div>
              <span class="fixed-tag">默认内置</span>
            </div>
            <p class="fixed-note">无需选择，建群后自动加入且不可移除。</p>
          </div>
          <div class="picker-label">选择其他成员</div>
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
          <p class="missing">
            每位成员在独立工作区按指令自主执行；需要公开的文件再发布到群共享区。
          </p>
          <p v-if="missing.length" class="missing">
            还没有：{{ missing.join('、') }}
            <LinkButton @click="newContact">去新建联系人</LinkButton>
          </p>
          <p v-if="tooMany" class="missing">
            一个群最多 {{ GROUP_MEMBER_LIMIT }} 位成员
          </p>
        </div>
      </section>

      <section class="form-section" data-group-section="announcement">
        <div class="form-section-head">
          <h3>3. 可选群公告</h3>
        </div>
        <Field hint="每位成员发言前都会读到" data-new-group-charter>
          <TextArea
            v-model="charter"
            :min-rows="3"
            :max-rows="8"
            placeholder="目标、约束"
          />
        </Field>
      </section>
    </div>
    <template #footer>
      <div class="primary-actions" data-group-primary>
        <Button @click="open = false">取消</Button>
        <Button
          variant="primary"
          :disabled="!ready"
          :loading="creating"
          @click="create"
          >建群</Button
        >
      </div>
    </template>
  </Modal>
</template>

<style scoped>
.new-group {
  display: grid;
  gap: var(--space-3-5);
}

.form-section {
  display: grid;
  gap: var(--space-3);
  min-width: 0;
}

.form-section + .form-section {
  padding-top: var(--space-3-5);
  box-shadow: inset 0 0.5px 0 var(--hairline);
}

.form-section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
}

.form-section-head h3 {
  margin: 0;
  color: rgb(var(--text-1));
  font-size: var(--fs-s);
  font-weight: var(--weight-semibold);
}

.form-section-head span {
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
}

.primary-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  width: 100%;
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

.fixed-member {
  display: flex;
  align-items: center;
  gap: var(--space-2-5);
  min-width: 0;
  padding: var(--space-2-5) var(--space-3);
  border-radius: var(--r-md);
  background: rgb(var(--accent-soft));
  box-shadow: inset 0 0 0 0.5px var(--hairline);
}

.fixed-copy {
  flex: 1;
  min-width: 0;
}

.fixed-copy b,
.fixed-copy span {
  display: block;
}

.fixed-copy b {
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.fixed-copy span,
.fixed-note {
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.fixed-tag {
  flex: none;
  padding: var(--space-0-5) var(--space-2);
  border-radius: var(--r-full);
  box-shadow: inset 0 0 0 0.5px var(--stroke-2);
  color: rgb(var(--text-2));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.fixed-note {
  margin: var(--space-1) 0 0;
}

.picker-label {
  color: rgb(var(--text-2));
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

@media (max-width: 520px) {
  .templates {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .people {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
