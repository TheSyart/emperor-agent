<script setup lang="ts">
/**
 * Settings › 群聊 (GRP-08, D14): what a new group starts with — the
 * collaboration (自主 by default, or 主持人审核) and the loop guard (on by
 * default). Saved at once (`groups.setDefaults`, settings.json `groups`);
 * a group made before keeps its own settings, changed in its 群设置. A
 * change that fails says so and the choice goes back.
 */
import { onMounted, ref } from 'vue'
import { core } from '../../api/http'
import { useAppContext } from '../../composables/useAppContext'
import Surface from '../ui/Surface.vue'
import { SettingsGroup, SettingsRow, SettingsSection, Switch } from './ui'

type Collaboration = 'autonomous' | 'moderated'
interface Defaults {
  collaboration: Collaboration
  loopGuard: boolean
}

const ctx = useAppContext()
const defaults = ref<Defaults>({ collaboration: 'autonomous', loopGuard: true })

const COLLABORATIONS: { value: Collaboration; title: string; text: string }[] =
  [
    {
      value: 'autonomous',
      title: '自主（默认）',
      text: '没人被 @ 时，和职责有关的成员举手发言；成员之间可以直接点名、直接交办。',
    },
    {
      value: 'moderated',
      title: '主持人审核',
      text: '没人被 @ 时由主持人安排；成员点名别人、交办别人，先交给主持人批准、改顺序或驳回。',
    },
  ]

onMounted(async () => {
  try {
    defaults.value = await core('groups.defaults')
  } catch (error) {
    ctx.showError(error, '群聊的默认设置没有读到')
  }
})

async function save(change: Partial<Defaults>): Promise<void> {
  const before = defaults.value
  defaults.value = { ...before, ...change }
  try {
    defaults.value = await core('groups.setDefaults', change)
  } catch (error) {
    defaults.value = before
    ctx.showError(error, '没有保存')
  }
}

function chooseCollaboration(value: Collaboration): void {
  if (value !== defaults.value.collaboration)
    void save({ collaboration: value })
}
</script>

<template>
  <SettingsSection>
    <SettingsGroup
      title="新群的默认设置"
      description="新建的群按这里初始化；已有的群不变，在群设置里单独改"
    >
      <SettingsRow
        title="协作方式"
        description="你自己的 @ 和交办永远不需要审核；不论哪种方式，改项目代码都要你确认"
        layout="stacked"
      >
        <div class="options" role="radiogroup" aria-label="协作方式">
          <Surface
            v-for="option in COLLABORATIONS"
            :key="option.value"
            as="button"
            pad="sm"
            interactive
            role="radio"
            class="option"
            :aria-checked="defaults.collaboration === option.value"
            :data-default-collaboration="option.value"
            @click="chooseCollaboration(option.value)"
          >
            <b>{{ option.title }}</b>
            <span>{{ option.text }}</span>
          </Surface>
        </div>
      </SettingsRow>
      <SettingsRow
        title="防打转"
        description="两位成员来回、没有新内容时，主持人介入换人或收尾；没有主持人就先停下问你。按有没有新内容判断，不是额度，不限次数"
        data-default="loopGuard"
      >
        <Switch
          :model-value="defaults.loopGuard"
          aria-label="防打转"
          @update:model-value="save({ loopGuard: $event })"
        />
      </SettingsRow>
    </SettingsGroup>
  </SettingsSection>
</template>

<style scoped>
.options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
}

.option {
  display: grid;
  align-content: start;
  gap: var(--space-1);
  color: rgb(var(--text-2));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  text-align: left;
}

.option b {
  color: rgb(var(--text-1));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: var(--weight-semibold);
}

.option[aria-checked='true'] {
  background: rgb(var(--accent-soft));
  box-shadow: inset 0 0 0 1px rgb(var(--accent));
}

@container (max-width: 440px) {
  .options {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
