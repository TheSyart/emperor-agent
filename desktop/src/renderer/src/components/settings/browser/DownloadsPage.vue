<script setup lang="ts">
/**
 * 设置 › 浏览器 › 下载历史记录 — two lists, newest first:
 * - 你的下载: what you downloaded in the built-in browser. A finished file
 *   that is still there can be opened or shown in Finder; 移除 takes a row
 *   off the list (the file stays). A blocked download says why.
 * - Emperor 的下载: the Agent's download inbox, with the same three actions
 *   as its tool rows: 在访达中显示, 移到工作区 (the conversation's
 *   workspace) and 另存为….
 * Each row reads 「网站 · 时间 · 状态」 under the file name; an empty list
 * says 暂无. How the last action went is a SettingsNotice at the top (an
 * error, or a one-line info such as 已另存). Main reports each of your
 * downloads as it goes (`onUserDownload`) and the list follows. Only ids go
 * back to main; no path reaches this page.
 */
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import {
  fetchDownloadHistory,
  moveAgentDownload,
  onUserDownload,
  openUserDownload,
  removeUserDownload,
  revealAgentDownload,
  revealUserDownload,
  saveAgentDownloadAs,
  type AgentDownloadView,
  type UserDownloadView,
} from '../../../api/backend'
import Button from '../../ui/Button.vue'
import {
  EmptyState,
  SettingsGroup,
  SettingsNotice,
  SettingsRow,
  SettingsSection,
} from '../ui'
import {
  agentDownloadDescription,
  userDownloadDescription,
} from './downloadsModel'

const mine = shallowRef<UserDownloadView[]>([])
const emperor = shallowRef<AgentDownloadView[]>([])
const busy = ref(false)
const error = ref('')
const notice = ref('')

async function reload(): Promise<void> {
  const history = await fetchDownloadHistory()
  mine.value = history.user
  emperor.value = history.agent
}

/** One action at a time; then the lists are read again. */
async function run(
  action: () => Promise<unknown>,
  done?: (result: unknown) => string,
): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await action()
    notice.value = done?.(result) ?? ''
    await reload()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}

function finished(view: UserDownloadView): boolean {
  return view.state === 'completed' && view.exists !== false
}

function follow(view: UserDownloadView): void {
  const known = mine.value.some((entry) => entry.id === view.id)
  mine.value = known
    ? mine.value.map((entry) => (entry.id === view.id ? view : entry))
    : [view, ...mine.value]
}

let unsubscribe = () => {}

onMounted(() => {
  unsubscribe = onUserDownload(follow)
  void reload()
})

onBeforeUnmount(() => unsubscribe())
</script>

<template>
  <SettingsSection
    intro="这里列出你和 Emperor 下载的文件，从列表移除不会删除文件。"
  >
    <SettingsNotice v-if="error" tone="error" :title="error" />
    <SettingsNotice v-else-if="notice" tone="info" :title="notice" />
    <SettingsGroup title="你的下载">
      <EmptyState v-if="!mine.length" compact title="暂无" />
      <SettingsRow
        v-for="item in mine"
        :key="item.id"
        :title="item.name"
        :description="userDownloadDescription(item)"
        :data-download="item.id"
        dense
      >
        <template v-if="finished(item)">
          <Button
            size="sm"
            variant="outline"
            :disabled="busy"
            @click="run(() => openUserDownload(item.id))"
            >打开</Button
          >
          <Button
            size="sm"
            variant="outline"
            :disabled="busy"
            @click="run(() => revealUserDownload(item.id))"
            >在访达中显示</Button
          >
        </template>
        <Button
          v-if="item.state !== 'progressing'"
          size="sm"
          variant="outline"
          :disabled="busy"
          :aria-label="`从列表移除 ${item.name}`"
          @click="run(() => removeUserDownload(item.id))"
          >移除</Button
        >
      </SettingsRow>
    </SettingsGroup>
    <SettingsGroup
      title="Emperor 的下载"
      description="Emperor 在对话里下载的文件先放进收件箱，按「下载保留时间」自动删除。"
    >
      <EmptyState v-if="!emperor.length" compact title="暂无" />
      <SettingsRow
        v-for="item in emperor"
        :key="item.id"
        :title="item.name"
        :description="agentDownloadDescription(item)"
        :data-download="item.id"
        dense
      >
        <template v-if="item.exists">
          <Button
            size="sm"
            variant="outline"
            :disabled="busy"
            @click="run(() => revealAgentDownload(item.id))"
            >在访达中显示</Button
          >
          <Button
            v-if="item.sessionId"
            size="sm"
            variant="outline"
            :disabled="busy"
            @click="
              run(
                () => moveAgentDownload(item.id),
                () => '已移到工作区的 downloads 文件夹',
              )
            "
            >移到工作区</Button
          >
          <Button
            size="sm"
            variant="outline"
            :disabled="busy"
            @click="
              run(
                () => saveAgentDownloadAs(item.id),
                (saved) => (saved ? '已另存' : ''),
              )
            "
            >另存为…</Button
          >
        </template>
      </SettingsRow>
    </SettingsGroup>
  </SettingsSection>
</template>
