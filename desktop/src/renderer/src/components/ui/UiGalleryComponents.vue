<script setup lang="ts">
/**
 * UiGalleryComponents — the DS-04 part of the dev-only UiGallery: every
 * display, input and surface component in every state, for the visual
 * suite (tests/visual/ui-gallery.spec.ts) in both themes. Each block is
 * marked with data-gallery-component so the suite can check none is
 * missing.
 */
import { ref } from 'vue'
import { providerIconAsset } from '../../model/providerIcons'
import Avatar from './Avatar.vue'
import Badge from './Badge.vue'
import Checkbox from './Checkbox.vue'
import Dot from './Dot.vue'
import EmptyState from './EmptyState.vue'
import Field from './Field.vue'
import Icon from './Icon.vue'
import IconButton from './IconButton.vue'
import Button from './Button.vue'
import List from './List.vue'
import ListRow from './ListRow.vue'
import ListSection from './ListSection.vue'
import Notice from './Notice.vue'
import PaneHeader from './PaneHeader.vue'
import SearchField from './SearchField.vue'
import Segmented from './Segmented.vue'
import Select from './Select.vue'
import Surface from './Surface.vue'
import Switch from './Switch.vue'
import Tabs from './Tabs.vue'
import Tag from './Tag.vue'
import TextArea from './TextArea.vue'
import TextField from './TextField.vue'
import { AVATAR_SIZES } from './avatar'

const tones = [
  'neutral',
  'accent',
  'ok',
  'warn',
  'error',
  'attention',
  'info',
] as const
const dotStates = ['ok', 'warn', 'error', 'running', 'idle'] as const
const pluginArt = providerIconAsset('deepseek')

const selectedRow = ref('b')
const filterTags = ref(['全部'])
const files = ref(['README.md', 'design.png'])
const checks = ref({ a: false, b: true })
const mixed = ref(true)
const name = ref('Emperor')
const url = ref('')
const prose = ref('第一行\n第二行')
const query = ref('')
const filled = ref('子智能体')
const effort = ref('medium')
const range = ref('7d')
const view = ref('list')
const switches = ref({ on: true, off: false })
const pageTab = ref('chat')
const filterTab = ref('open')
const editorTab = ref('pkg')
const editorTabs = ref([
  { id: 'pkg', label: 'package.json', closable: true },
  { id: 'readme', label: 'README.md', closable: true },
  { id: 'term', label: '终端 1', closable: true },
])
const headerTab = ref('files')

function toggleFilter(label: string) {
  filterTags.value = filterTags.value.includes(label)
    ? filterTags.value.filter((item) => item !== label)
    : [...filterTags.value, label]
}

function closeEditorTab(id: string) {
  editorTabs.value = editorTabs.value.filter((tab) => tab.id !== id)
}
</script>

<template>
  <section class="kit" data-testid="ui-gallery-components">
    <h2>Display, input and surface components (DS-04)</h2>

    <div class="cell" data-gallery-component="Badge">
      <h3>Badge</h3>
      <div class="row">
        <Badge v-for="tone in tones" :key="tone" :tone="tone">{{ tone }}</Badge>
      </div>
      <div class="row">
        <Badge variant="count" :label="3" />
        <Badge variant="count" tone="error" :label="12" />
        <Badge variant="count" tone="accent" :label="128" />
        <Badge
          v-for="tone in tones"
          :key="tone"
          :tone="tone"
          variant="dot-label"
        >
          {{ tone }}
        </Badge>
        <Badge mono>v1.29.0</Badge>
      </div>
    </div>

    <div class="cell" data-gallery-component="Tag">
      <h3>Tag</h3>
      <div class="row">
        <Tag
          v-for="label in ['全部', '运行中', '失败']"
          :key="label"
          :label="label"
          :selected="filterTags.includes(label)"
          @click="toggleFilter(label)"
        />
        <Tag
          v-for="file in files"
          :key="file"
          :label="file"
          removable
          @remove="files = files.filter((item) => item !== file)"
        >
          <template #leading><Icon name="file-text" size="sm" /></template>
        </Tag>
        <Tag label="停用" disabled />
      </div>
    </div>

    <div class="cell" data-gallery-component="Dot">
      <h3>Dot</h3>
      <div class="row">
        <span v-for="state in dotStates" :key="state" class="pair">
          <Dot :state="state" /><Dot :state="state" size="sm" />
          <em>{{ state }}</em>
        </span>
      </div>
    </div>

    <div class="cell" data-gallery-component="Avatar">
      <h3>Avatar</h3>
      <div class="row">
        <Avatar
          v-for="size in AVATAR_SIZES"
          :key="`sprite-${size}`"
          kind="sprite"
          :id="`gallery-agent-${size}`"
          :size="size"
        />
        <Avatar
          kind="sprite"
          id="gallery-running"
          status="running"
          :size="28"
        />
        <Avatar kind="sprite" id="gallery-done" status="completed" :size="28" />
        <Avatar kind="sprite" id="gallery-failed" status="failed" :size="28" />
      </div>
      <div class="row">
        <Avatar
          v-for="size in AVATAR_SIZES"
          :key="`logo-${size}`"
          kind="logo"
          icon-id="anthropic"
          label="Anthropic"
          :size="size"
        />
        <Avatar kind="logo" icon-id="openai" label="OpenAI" :size="28" />
        <Avatar kind="logo" :src="pluginArt" label="DeepSeek" :size="28" />
        <Avatar kind="logo" icon-id="unknown-gateway" label="网关" :size="28" />
        <Avatar kind="color" id="designer" label="设计" :size="28" />
        <Avatar kind="color" id="reviewer" label="Review" :size="28" />
        <Avatar kind="initials" label="GitHub" :size="28" />
        <Avatar kind="initials" label="Emperor" :size="40" />
      </div>
    </div>

    <div class="cell wide" data-gallery-component="List">
      <h3>List · ListSection · ListRow</h3>
      <List label="示例列表" class="demo-list">
        <ListSection title="今天" data-gallery-component="ListSection">
          <ListRow
            title="重做侧栏"
            :selected="selectedRow === 'a'"
            data-gallery-component="ListRow"
            @select="selectedRow = 'a'"
          >
            <template #leading><Dot state="running" /></template>
            <template #meta>3 分钟前</template>
            <template #trailing>
              <IconButton label="更多" size="xs"
                ><Icon name="more" size="sm"
              /></IconButton>
            </template>
          </ListRow>
          <ListRow
            title="选中的行"
            :selected="selectedRow === 'b'"
            @select="selectedRow = 'b'"
          >
            <template #leading
              ><Icon name="message-square" size="md"
            /></template>
            <template #meta>昨天</template>
          </ListRow>
          <ListRow title="子会话" nested @select="selectedRow = 'c'">
            <template #leading
              ><Avatar kind="sprite" id="row-child" :size="16"
            /></template>
          </ListRow>
        </ListSection>
        <ListSection title="更早">
          <ListRow
            size="md"
            title="40px 行"
            subtitle="带副标题"
            @select="selectedRow = 'd'"
          >
            <template #leading
              ><Avatar kind="logo" icon-id="openai" label="OpenAI" :size="24"
            /></template>
            <template #meta><Badge variant="count" :label="4" /></template>
          </ListRow>
          <ListRow
            size="lg"
            title="52px 行"
            subtitle="插件、技能或工具"
            @select="selectedRow = 'e'"
          >
            <template #leading
              ><Avatar kind="initials" label="Hooks" :size="28"
            /></template>
            <template #meta
              ><Badge tone="ok" variant="dot-label">已启用</Badge></template
            >
          </ListRow>
          <ListRow title="删除对话" danger @select="selectedRow = 'f'">
            <template #leading><Icon name="trash" size="md" /></template>
          </ListRow>
          <ListRow title="停用的行" disabled />
        </ListSection>
      </List>
    </div>

    <div class="cell wide" data-gallery-component="Surface">
      <h3>Surface</h3>
      <div class="grid">
        <Surface tone="raised">raised · md</Surface>
        <Surface tone="sunken">sunken · md</Surface>
        <Surface tone="overlay">overlay · md</Surface>
        <Surface pad="sm" radius="lg">pad sm · radius lg</Surface>
        <Surface pad="none"><div class="pad-none">pad none</div></Surface>
        <Surface as="button" interactive>interactive (button)</Surface>
      </div>
    </div>

    <div class="cell wide" data-gallery-component="EmptyState">
      <h3>EmptyState</h3>
      <div class="grid two">
        <EmptyState
          title="暂无定时任务"
          description="新建一个任务，按时自动运行。"
        >
          <template #icon><Icon name="inbox" size="lg" /></template>
          <Button size="sm" variant="secondary">新建任务</Button>
        </EmptyState>
        <EmptyState
          title="暂无归档对话"
          description="归档的对话会出现在这里。"
          framed
        />
        <EmptyState
          title="没有匹配的会话"
          description="换个关键词试试"
          variant="inline"
        />
        <EmptyState title="还没有服务器" variant="inline" framed>
          <Button size="sm" variant="ghost">添加</Button>
        </EmptyState>
      </div>
    </div>

    <div class="cell wide" data-gallery-component="Notice">
      <h3>Notice</h3>
      <div class="stack">
        <Notice
          tone="warn"
          title="还没有授权辅助功能"
          description="打开系统设置，允许 Emperor Agent 控制电脑。"
        >
          <template #actions>
            <Button size="sm" variant="secondary">打开系统设置</Button>
          </template>
        </Notice>
        <Notice tone="error" title="连接失败" description="检查网络后重试。" />
        <Notice
          v-for="tone in [
            'neutral',
            'info',
            'ok',
            'attention',
            'accent',
          ] as const"
          :key="tone"
          :tone="tone"
          :title="`${tone} 提示`"
          description="一行说明。"
        />
      </div>
    </div>

    <div class="cell" data-gallery-component="Checkbox">
      <h3>Checkbox</h3>
      <div class="stack">
        <Checkbox v-model="checks.a">未选中</Checkbox>
        <Checkbox v-model="checks.b">已选中</Checkbox>
        <Checkbox v-model="checks.a" v-model:indeterminate="mixed"
          >部分选中</Checkbox
        >
        <Checkbox :model-value="true" disabled>停用</Checkbox>
      </div>
    </div>

    <div class="cell" data-gallery-component="Switch">
      <h3>Switch</h3>
      <div class="row">
        <Switch v-model="switches.on" aria-label="开启" />
        <Switch v-model="switches.off" aria-label="关闭" />
        <Switch :model-value="true" disabled aria-label="停用" />
      </div>
    </div>

    <div class="cell" data-gallery-component="TextField">
      <h3>TextField · Field</h3>
      <div class="stack">
        <Field
          label="名称"
          hint="最多 120 字"
          required
          data-gallery-component="Field"
        >
          <TextField v-model="name" placeholder="名称" />
        </Field>
        <Field label="地址" error="请输入有效的网址" badge="已覆盖">
          <TextField v-model="url" placeholder="https://" monospace />
        </Field>
        <TextField v-model="name" size="sm">
          <template #leading><Icon name="globe" size="sm" /></template>
        </TextField>
        <TextField model-value="只读" disabled />
      </div>
    </div>

    <div class="cell" data-gallery-component="TextArea">
      <h3>TextArea</h3>
      <div class="stack">
        <TextArea v-model="prose" :min-rows="2" />
        <TextArea model-value="" placeholder="写点说明" invalid :min-rows="2" />
      </div>
    </div>

    <div class="cell" data-gallery-component="SearchField">
      <h3>SearchField</h3>
      <div class="stack">
        <SearchField v-model="query" placeholder="搜索对话" />
        <SearchField v-model="filled" placeholder="搜索" />
        <SearchField v-model="query" size="sm" placeholder="筛选文件">
          <template #trailing>12</template>
        </SearchField>
      </div>
    </div>

    <div class="cell" data-gallery-component="Select">
      <h3>Select</h3>
      <div class="stack">
        <Select
          v-model="effort"
          aria-label="思考强度"
          :options="[
            { value: 'low', label: '低' },
            { value: 'medium', label: '中', description: '默认' },
            { value: 'high', label: '高' },
          ]"
        />
        <Select
          v-model="effort"
          size="sm"
          aria-label="思考强度（紧凑）"
          :options="[
            { value: 'low', label: '低' },
            { value: 'medium', label: '中' },
          ]"
        />
        <Select :model-value="undefined" aria-label="未选" :options="[]" />
      </div>
    </div>

    <div class="cell" data-gallery-component="Segmented">
      <h3>Segmented</h3>
      <div class="stack">
        <Segmented
          v-model="range"
          aria-label="范围"
          :options="[
            { value: '7d', label: '7 天' },
            { value: '30d', label: '30 天' },
            { value: 'all', label: '全部' },
          ]"
        />
        <Segmented
          v-model="view"
          size="md"
          block
          aria-label="视图"
          :options="[
            { value: 'list', label: '列表' },
            { value: 'grid', label: '网格' },
            { value: 'off', label: '停用', disabled: true },
          ]"
        />
      </div>
    </div>

    <div class="cell wide" data-gallery-component="Tabs">
      <h3>Tabs</h3>
      <div class="stack">
        <Tabs
          v-model="pageTab"
          aria-label="页面"
          :tabs="[
            { id: 'chat', label: '对话' },
            { id: 'trajectory', label: '轨迹' },
            { id: 'off', label: '停用', disabled: true },
          ]"
        />
        <Tabs
          v-model="pageTab"
          size="large"
          aria-label="页面（大）"
          :tabs="[
            { id: 'chat', label: '对话' },
            { id: 'trajectory', label: '轨迹' },
          ]"
        />
        <Tabs
          v-model="filterTab"
          variant="segmented"
          aria-label="筛选"
          :tabs="[
            { id: 'open', label: '打开', count: 12 },
            { id: 'merged', label: '已合并', count: 3 },
            { id: 'closed', label: '已关闭' },
          ]"
        />
        <Tabs
          v-model="editorTab"
          variant="editor"
          aria-label="文件"
          :tabs="editorTabs"
          @close="closeEditorTab"
        />
      </div>
    </div>

    <div class="cell wide" data-gallery-component="PaneHeader">
      <h3>PaneHeader</h3>
      <div class="stack panes">
        <PaneHeader title="工作台" />
        <PaneHeader title="审查">
          <template #tabs>
            <Tabs
              v-model="headerTab"
              aria-label="审查视图"
              :tabs="[
                { id: 'files', label: '文件' },
                { id: 'git', label: 'Git' },
              ]"
            />
          </template>
          <template #actions>
            <IconButton label="刷新"
              ><Icon name="refresh" size="md"
            /></IconButton>
            <IconButton label="更多"><Icon name="more" size="md" /></IconButton>
          </template>
        </PaneHeader>
        <PaneHeader
          title="一个很长很长的标题，会在空间不够时截断而不是把栏撑高"
        >
          <template #leading>
            <IconButton label="返回"
              ><Icon name="chevron-left" size="md"
            /></IconButton>
          </template>
          <template #tabs>
            <Tabs
              v-model="filterTab"
              variant="segmented"
              aria-label="状态"
              :tabs="[
                { id: 'open', label: '打开' },
                { id: 'closed', label: '关闭' },
              ]"
            />
          </template>
          <template #actions>
            <Button size="sm" variant="secondary">新建</Button>
          </template>
        </PaneHeader>
      </div>
    </div>
  </section>
</template>

<style scoped>
.kit {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4);
}

h2 {
  grid-column: 1 / -1;
}

h3 {
  margin: 0 0 var(--space-2);
  color: rgb(var(--text-3));
  font: var(--weight-medium) var(--type-caption) var(--font-sans);
}

.cell {
  min-width: 0;
  padding: var(--space-3);
  border-radius: var(--r-md);
  background: rgb(var(--surface-base));
  box-shadow: inset 0 0 0 0.5px var(--hairline);
}

.cell.wide {
  grid-column: 1 / -1;
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.row + .row {
  margin-top: var(--space-2);
}

.stack {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-2);
}

.grid.two {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.pair {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  margin-right: var(--space-2);
}

.pair em {
  color: rgb(var(--text-3));
  font: var(--weight-regular) var(--type-caption) var(--font-sans);
  font-style: normal;
}

.demo-list {
  max-width: 420px;
}

.pad-none {
  padding: var(--space-2);
  color: rgb(var(--text-3));
}

.panes {
  overflow: hidden;
  border-radius: var(--r-sm);
  background: rgb(var(--surface-canvas));
}
</style>
