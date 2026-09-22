<script setup lang="ts">
/**
 * SettingsGallery — dev-only showcase of the settings primitives inside a
 * mock settings panel (188px nav + 54px header + 564px options column), so
 * they are judged at their real width. Mounted by main.ts on
 * `?settings-gallery`; captured by tests/visual/settings-gallery.spec.ts in
 * light and dark.
 */
import { ref } from 'vue'
import Button from '../../ui/Button.vue'
import StateDot from '../../ui/StateDot.vue'
import { DsClose, DsCode, DsFolderOpen, DsLink, DsPlus } from '../../icons/ds'
import SettingsHeaderBar from '../SettingsHeaderBar.vue'
import SettingsNav from '../SettingsNav.vue'
import { createSettingsHeader, refreshAction } from '../settingsHeader'
import {
  CodeEditor,
  DefinitionList,
  EmptyState,
  Field,
  Metric,
  SearchField,
  Segmented,
  Select,
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  StatusBadge,
  Switch,
  TextArea,
  TextField,
} from './index'

const header = createSettingsHeader()
const saving = ref(false)
header.register(() => [
  refreshAction(() => new Promise((resolve) => setTimeout(resolve, 900))),
  {
    id: 'add',
    label: '新增',
    icon: DsPlus,
    menu: [
      {
        id: 'paste',
        label: '粘贴 JSON',
        description: '识别 mcpServers / servers 格式',
        icon: DsCode,
        onSelect: () => undefined,
      },
      {
        id: 'folder',
        label: '选择本地文件夹',
        icon: DsFolderOpen,
        onSelect: () => undefined,
      },
      {
        id: 'url',
        label: '从 URL 导入',
        icon: DsLink,
        onSelect: () => undefined,
      },
    ],
  },
  {
    id: 'save',
    label: '保存',
    kind: 'primary',
    busy: saving.value,
    onClick: () => undefined,
  },
])

const autoCompact = ref(true)
const fallback = ref(false)
const lockedSwitch = ref(true)
const reasoning = ref('medium')
const range = ref('30d')
const view = ref('trend')
const name = ref('aihot')
const url = ref('https://mcp.example.com/sse?token=•••')
const brokenUrl = ref('ftp://nope')
const path = ref('~/.emperor/skills/writer')
const notes = ref('每次调用前先检查网络连通性。\n失败时回退到本地缓存。')
const query = ref('mcp')
const cardOpen = ref(true)
const cardClosed = ref(false)
const json = ref(`{
  "mcpServers": {
    "aihot": {
      "type": "http",
      "url": "https://aihot.example.com/mcp",
      "headers": { "Authorization": "Bearer \${AIHOT_TOKEN}" }
    },
    "exa": {
      "command": "npx",
      "args": ["-y", "exa-mcp-server", "--tools=web_search_exa,research_paper_search,company_research,crawling,competitor_finder"]
    }
  }
}`)

const reasoningOptions = [
  { value: 'low', label: '低', description: '更快，适合简单任务' },
  { value: 'medium', label: '中', description: '默认平衡' },
  { value: 'high', label: '高', description: '更深入的推理，耗时更长' },
  { value: 'max', label: '最高', disabled: true },
]
const transportOptions = [
  { value: 'stdio', label: 'stdio' },
  { value: 'http', label: 'Streamable HTTP' },
  { value: 'sse', label: 'SSE' },
]
const transport = ref('http')
const rangeOptions = [
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
  { value: '90d', label: '90 天' },
  { value: 'all', label: '全部' },
]
const viewOptions = [
  { value: 'heatmap', label: '热力图' },
  { value: 'trend', label: '趋势' },
  { value: 'ranking', label: '排行' },
]
const facts = [
  { term: '传输', value: 'Streamable HTTP' },
  { term: 'URL', value: 'https://aihot.example.com/mcp', mono: true },
  {
    term: '命令',
    value:
      'npx -y exa-mcp-server --tools=web_search_exa,research_paper_search,company_research',
    mono: true,
  },
  { term: '工具数', value: 12 },
  { term: '最近错误', value: null },
]
</script>

<template>
  <div class="gallery" data-testid="settings-gallery">
    <div class="panel">
      <SettingsNav active="mcp" title-id="gallery-title" @select="() => {}" />
      <div class="content">
        <div class="header">
          <h2 class="title">组件库</h2>
          <div class="header-actions">
            <SettingsHeaderBar :actions="header.actions.value" />
            <button type="button" class="close" aria-label="关闭设置">
              <DsClose :size="14" />
            </button>
          </div>
        </div>
        <div class="options">
          <SettingsSection
            intro="设置分区的基础组件：行、分组、卡片、表单、展示。所有尺寸按 dsh 设置面板，内容区 564px。"
          >
            <SettingsRow
              title="自动压缩"
              description="上下文接近上限时自动整理历史"
              label-for="gallery-compact"
            >
              <Switch id="gallery-compact" v-model="autoCompact" />
            </SettingsRow>
            <SettingsRow title="失败回退" label-for="gallery-fallback">
              <template #badge>
                <StatusBadge tone="accent">实验</StatusBadge>
              </template>
              <Switch id="gallery-fallback" v-model="fallback" />
            </SettingsRow>
            <SettingsRow
              title="托管锁定"
              description="由组织策略控制，不能在这里修改"
            >
              <Switch v-model="lockedSwitch" disabled aria-label="托管锁定" />
            </SettingsRow>
            <SettingsRow
              title="思考强度"
              description="影响推理深度与耗时（Select，基于 ui/Menu）"
            >
              <Select
                v-model="reasoning"
                :options="reasoningOptions"
                aria-label="思考强度"
                data-testid="gallery-select"
              />
            </SettingsRow>
            <SettingsRow title="统计范围" description="Segmented">
              <Segmented
                v-model="range"
                :options="rangeOptions"
                aria-label="统计范围"
              />
            </SettingsRow>
            <SettingsRow title="服务器名称" description="行内 TextField（sm）">
              <TextField
                v-model="name"
                size="sm"
                class="inline-field"
                aria-label="服务器名称"
              />
            </SettingsRow>

            <SettingsGroup
              title="表单"
              description="Field 负责标签、提示与错误，并把 id / aria 接到控件上"
              variant="form"
            >
              <Field label="URL" hint="支持 http(s)；query 中的 token 会被遮罩">
                <TextField v-model="url" monospace />
              </Field>
              <Field
                label="回调地址"
                error="只支持 http 或 https 地址"
                required
              >
                <TextField v-model="brokenUrl" monospace />
              </Field>
              <Field label="安装路径" badge="只读" hint="内置来源不可修改">
                <TextField v-model="path" monospace disabled />
              </Field>
              <Field label="传输方式">
                <Select v-model="transport" :options="transportOptions" block />
              </Field>
              <Field label="备注" hint="TextArea 随内容增高，3–10 行">
                <TextArea v-model="notes" />
              </Field>
              <Field
                label="mcp_config.json"
                hint="⌘S 保存；长行在编辑器内横向滚动"
              >
                <CodeEditor v-model="json" language="json" :max-lines="14" />
              </Field>
              <Field label="视图">
                <Segmented
                  v-model="view"
                  :options="viewOptions"
                  size="md"
                  block
                />
              </Field>
            </SettingsGroup>

            <SettingsGroup
              title="卡片"
              description="SettingsCard：可展开、actions 区不触发展开"
              variant="stack"
            >
              <SettingsCard
                v-model:open="cardOpen"
                title="aihot"
                description="热点聚合 · 12 个工具"
                expandable
              >
                <template #leading><StateDot state="ok" /></template>
                <template #meta>
                  <StatusBadge mono>http</StatusBadge>
                  <StatusBadge tone="ok" dot>已连接</StatusBadge>
                </template>
                <template #actions>
                  <Switch :model-value="true" aria-label="启用 aihot" />
                </template>
                <DefinitionList :items="facts" />
                <template #footer>
                  <Button size="sm" variant="danger">删除</Button>
                  <Button size="sm" variant="outline">取消</Button>
                  <Button size="sm" variant="primary">保存</Button>
                </template>
              </SettingsCard>
              <SettingsCard
                v-model:open="cardClosed"
                title="exa"
                description="npx exa-mcp-server"
                expandable
              >
                <template #leading><StateDot state="error" /></template>
                <template #meta>
                  <StatusBadge mono>stdio</StatusBadge>
                  <StatusBadge tone="error" dot>启动失败</StatusBadge>
                </template>
                <template #actions>
                  <Switch :model-value="false" aria-label="启用 exa" />
                </template>
                <DefinitionList :items="facts" />
              </SettingsCard>
              <SettingsCard
                title="outline 变体"
                description="面板上的行卡片（模型 provider 行）"
                variant="outline"
              >
                <template #actions>
                  <Button size="sm" variant="outline">编辑</Button>
                </template>
              </SettingsCard>
              <SettingsCard variant="filled">
                <Field label="filled 变体 · 内嵌编辑表单">
                  <TextField v-model="name" />
                </Field>
                <template #footer>
                  <Button size="sm" variant="outline">取消</Button>
                  <Button size="sm" variant="primary">添加</Button>
                </template>
              </SettingsCard>
            </SettingsGroup>

            <SettingsGroup title="搜索与空状态" variant="stack">
              <SearchField v-model="query" placeholder="搜索 Skill">
                <template #trailing>3 / 12</template>
              </SearchField>
              <EmptyState
                title="还没有 MCP 服务器"
                description="粘贴 Claude / Cursor / VS Code 的配置，或手动填写 URL 与命令。"
              >
                <Button size="sm" variant="outline">粘贴 JSON</Button>
                <Button size="sm" variant="primary">添加服务器</Button>
              </EmptyState>
              <EmptyState
                title="暂无归档对话。"
                description="compact 变体：列表内的单行空状态"
                compact
              />
            </SettingsGroup>

            <SettingsGroup title="状态与指标" variant="stack">
              <div class="badges">
                <StatusBadge tone="ok" dot>已连接</StatusBadge>
                <StatusBadge tone="warn" dot>版本不匹配</StatusBadge>
                <StatusBadge tone="error" dot>启动失败</StatusBadge>
                <StatusBadge tone="neutral">已禁用</StatusBadge>
                <StatusBadge tone="accent">推荐</StatusBadge>
                <StatusBadge mono>v1.29.0</StatusBadge>
              </div>
              <div class="metrics">
                <Metric label="总 Token" value="1.28M" hint="近 30 天" />
                <Metric
                  label="请求数"
                  value="3,412"
                  unit="次"
                  hint="日均 114"
                />
                <Metric
                  label="缓存命中"
                  value="62%"
                  tone="ok"
                  hint="+8% 较上周"
                />
                <Metric label="失败" value="17" tone="error" hint="多为超时" />
              </div>
              <DefinitionList :items="facts" />
            </SettingsGroup>
          </SettingsSection>
        </div>
      </div>
    </div>

    <div class="narrow" data-testid="settings-gallery-narrow">
      <div class="narrow-caption">
        窄容器 360px：放不下的控件折到文字下方，开关等小控件留在右侧
      </div>
      <SettingsSection>
        <SettingsRow
          title="思考强度"
          description="文字至少 240px，放不下的控件换到下一行"
        >
          <Select v-model="reasoning" :options="reasoningOptions" />
        </SettingsRow>
        <SettingsRow title="统计范围">
          <Segmented v-model="range" :options="rangeOptions" />
        </SettingsRow>
        <SettingsRow title="自动压缩" description="开关仍在行内">
          <Switch v-model="autoCompact" aria-label="自动压缩" />
        </SettingsRow>
      </SettingsSection>
    </div>
  </div>
</template>

<style scoped>
.gallery {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-6);
  min-height: 100vh;
  padding: var(--space-6);
  background: rgb(var(--bg-base));
  color: rgb(var(--label-primary));
  font-family: var(--font-sans);
}

.panel {
  container: settings-panel / inline-size;
  display: flex;
  width: 800px;
  max-width: 100%;
  overflow: hidden;
  border-radius: var(--radius-modal);
  background: rgb(var(--bg-layer-2));
  box-shadow: var(--shadow-lv3);
}

.content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  height: 54px;
  padding: var(--space-5) var(--space-3-5) var(--space-2) var(--space-2-5);
}

.title {
  margin: 0;
  padding-left: var(--space-3-5);
  font-size: var(--fs-base);
  line-height: var(--lh-base);
  font-weight: 500;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.close {
  display: inline-grid;
  place-items: center;
  width: var(--space-7);
  height: var(--space-7);
  padding: 0;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: rgb(var(--label-primary));
}

.options {
  display: flex;
  flex-direction: column;
  padding: 0 var(--space-6) var(--space-6);
}

.inline-field {
  width: 200px;
}

.badges {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: var(--space-2);
}

.narrow {
  width: 360px;
  padding: 0 var(--space-6) var(--space-3);
  border-radius: var(--radius-takeover);
  background: rgb(var(--bg-layer-2));
  box-shadow: var(--shadow-lv3);
}

.narrow-caption {
  padding-top: var(--space-4);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
}
</style>
