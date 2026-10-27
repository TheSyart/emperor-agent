<script setup lang="ts">
/**
 * ContactMethods — the four ways to start a contact (GRP-04, D5): 从岗位
 * 模板, 说说你要什么人 (Emperor drafts), 导入 (one agent file the user
 * picks), 复制已有联系人. Every way ends in the same seven-section role
 * card below it. v-model: the way chosen.
 */
import Surface from '../ui/Surface.vue'
import type { ContactMethod } from './contactEditorModel'

const method = defineModel<ContactMethod>({ required: true })

const METHODS: ReadonlyArray<{
  key: ContactMethod
  title: string
  description: string
}> = [
  {
    key: 'template',
    title: '从岗位模板',
    description: '18 个岗位，按领域分组',
  },
  {
    key: 'brief',
    title: '说说你要什么人',
    description: 'Emperor 问几个问题后起草',
  },
  {
    key: 'import',
    title: '导入',
    description: 'Claude Code 的岗位文件或现成的提示词',
  },
  { key: 'copy', title: '复制已有联系人', description: '在别人的基础上改' },
]
</script>

<template>
  <div class="methods" role="group" aria-label="建立方式" data-contact-methods>
    <Surface
      v-for="item in METHODS"
      :key="item.key"
      as="button"
      pad="sm"
      interactive
      class="method"
      :data-method="item.key"
      :aria-pressed="method === item.key ? 'true' : 'false'"
      @click="method = item.key"
    >
      <span class="title">{{ item.title }}</span>
      <span class="description">{{ item.description }}</span>
    </Surface>
  </div>
</template>

<style scoped>
.methods {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: var(--space-1-5);
}

.method {
  display: flex;
  flex-direction: column;
  gap: var(--space-0-5);
  padding: var(--space-2) var(--space-3);
  text-align: left;
}

.method[aria-pressed='true'] {
  background: rgb(var(--accent-soft));
  box-shadow: inset 0 0 0 1px rgb(var(--accent));
}

.title {
  color: rgb(var(--text-1));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: var(--weight-medium);
}

.description {
  color: rgb(var(--text-3));
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
}
</style>
