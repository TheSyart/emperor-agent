<script setup lang="ts">
/**
 * AvatarRecommend — the avatar row of 1 身份 (GRP-04, D21): the avatar the
 * contact gets, why it was picked, 「换一个」 (another one at random from
 * the same theme — Core skips the ones in use and never offers one twice
 * while the theme has others) and 「从头像库选…」 (AvatarLibraryPicker). An
 * avatar another contact uses can be picked; the row says who uses it.
 *
 * Props: modelValue (v-model, ContactAvatar); templateId? (the theme to
 * draw from; none: people, animals, robots); inUse (avatar id → contact);
 * origin — what the first avatar is: `recommended` or the `saved` one;
 * epoch (a new start: the row forgets what it offered); name (for a
 * non-library avatar's letter); disabled?.
 * Emits: picked — the user chose one from the library (a new start keeps it).
 */
import { computed, ref, watch } from 'vue'
import type { ContactAvatar } from '@emperor/core/api'
import { core } from '../../api/http'
import Avatar from '../ui/Avatar.vue'
import Button from '../ui/Button.vue'
import {
  CONTACT_AVATAR_THEME_LABELS,
  contactAvatarTheme,
  type ContactAvatarEntry,
} from '../ui/contactAvatars'
import AvatarLibraryPicker from './AvatarLibraryPicker.vue'
import { contactAvatarProps } from './contactAvatar'

const props = withDefaults(
  defineProps<{
    templateId?: string | null
    inUse?: Readonly<Record<string, string>>
    origin?: 'recommended' | 'saved'
    epoch?: number
    name?: string
    disabled?: boolean
  }>(),
  {
    templateId: null,
    inUse: () => ({}),
    origin: 'recommended',
    epoch: 0,
    name: '',
    disabled: false,
  },
)
const avatar = defineModel<ContactAvatar>({ required: true })
const emit = defineEmits<{ picked: [] }>()

type How = 'recommended' | 'saved' | 'shuffled' | 'picked'
const how = ref<How>(props.origin)
/** The avatars offered before the one on screen (换一个 skips them). */
const offered = ref<string[]>([])
const labels = ref<Record<string, string>>({})
const shuffling = ref(false)
const failed = ref(false)
const pickerOpen = ref(false)

watch(
  () => props.templateId,
  () => {
    offered.value = []
  },
)
watch(
  () => [props.origin, props.epoch] as const,
  ([origin]) => {
    how.value = origin
    offered.value = []
  },
)

const libraryId = computed(() =>
  avatar.value.kind === 'library' ? avatar.value.id : null,
)
const shown = computed(() => contactAvatarProps(avatar.value, props.name))

const label = computed(() => {
  const id = libraryId.value
  if (!id) return props.name || '头像'
  const theme = contactAvatarTheme(id)
  return (
    labels.value[id] ??
    (theme ? `${CONTACT_AVATAR_THEME_LABELS[theme]}主题` : '头像库')
  )
})

const title = computed(() => {
  switch (how.value) {
    case 'picked':
      return `已选：${label.value}`
    case 'saved':
      return `现在的头像：${label.value}`
    default:
      return `推荐：${label.value}`
  }
})

const why = computed(() => {
  const theme = libraryId.value ? contactAvatarTheme(libraryId.value) : null
  switch (how.value) {
    case 'shuffled':
      return theme
        ? `从「${CONTACT_AVATAR_THEME_LABELS[theme]}」主题里随机换了一个，跳过别的联系人已在用的`
        : '随机换了一个，跳过别的联系人已在用的'
    case 'picked':
      return '你从头像库里选的'
    case 'saved':
      return '可以换一个，也可以从头像库里选'
    default:
      return props.templateId
        ? '按岗位随机推荐，跳过别的联系人已在用的'
        : '从人物、动物、机器人里随机推荐，跳过别的联系人已在用的'
  }
})

/** Who else has this avatar (a pick may share one; a recommendation never does). */
const sharedWith = computed(() =>
  libraryId.value ? (props.inUse[libraryId.value] ?? null) : null,
)

async function shuffle() {
  if (shuffling.value) return
  shuffling.value = true
  failed.value = false
  const current = libraryId.value
  const exclude = current ? [...offered.value, current] : [...offered.value]
  try {
    const next = await core('contacts.recommendAvatar', {
      ...(props.templateId ? { templateId: props.templateId } : {}),
      exclude,
    })
    if (current) offered.value = [...offered.value, current]
    avatar.value = { kind: 'library', id: next.id }
    how.value = 'shuffled'
  } catch {
    failed.value = true
  } finally {
    shuffling.value = false
  }
}

function remember(entries: readonly ContactAvatarEntry[]) {
  labels.value = Object.fromEntries(
    entries.map((entry) => [entry.id, entry.label]),
  )
}

function picked(id: string) {
  avatar.value = { kind: 'library', id }
  how.value = 'picked'
  emit('picked')
}
</script>

<template>
  <div class="recommend" data-avatar-recommend>
    <span class="portrait">
      <Avatar
        v-bind="shown"
        :size="shown.kind === 'library' ? 56 : 40"
        labelled
      />
    </span>
    <span class="meta">
      <span class="title">{{ title }}</span>
      <span class="why">{{ why }}</span>
      <span v-if="sharedWith" class="shared" role="note">
        「{{ sharedWith }}」也在用这个头像，仍然可以用
      </span>
      <span v-if="failed" class="shared" role="alert">没换成，再试一次</span>
      <span class="actions">
        <Button
          size="sm"
          variant="secondary"
          :loading="shuffling"
          :disabled="disabled"
          @click="shuffle"
          >换一个</Button
        >
        <Button size="sm" :disabled="disabled" @click="pickerOpen = true"
          >从头像库选…</Button
        >
      </span>
    </span>
    <AvatarLibraryPicker
      v-model:open="pickerOpen"
      :selected="libraryId"
      :in-use="inUse"
      @loaded="remember"
      @select="picked"
    />
  </div>
</template>

<style scoped>
.recommend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.portrait {
  display: inline-flex;
  border-radius: var(--r-full);
  box-shadow:
    0 0 0 2px rgb(var(--surface-raised)),
    0 0 0 3.5px rgb(var(--accent));
}

.meta {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.title {
  color: rgb(var(--text-1));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: var(--weight-medium);
}

.why,
.shared {
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.shared {
  color: rgb(var(--attention));
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1-5);
}
</style>
