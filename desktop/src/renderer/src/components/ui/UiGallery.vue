<script setup lang="ts">
/**
 * UiGallery — dev-only showcase of the dsh primitives, icons and tokens for
 * visual testing (mounted by main.ts when the URL carries `?ui-gallery`;
 * captured by tests/visual/ui-gallery.spec.ts in light and dark).
 */
import { ref } from 'vue'
import * as DsIcons from '../icons/ds'
import { DS_ICON_NAMES } from '../icons/ds'
import {
  Chip,
  CodeBlock,
  DiffBlock,
  DisclosureRow,
  ElapsedClock,
  IconButton,
  InOutCard,
  JsonTree,
  Menu,
  MenuItem,
  Modal,
  Pill,
  ReadBlock,
  SearchBlock,
  Shimmer,
  StateDot,
  Tabs,
  TerminalBlock,
  Toast,
  Tooltip,
  WebBlock,
} from './index'

const icons = DS_ICON_NAMES.map((name) => ({
  name,
  component: (DsIcons as Record<string, unknown>)[name],
}))

const tab = ref('chat')
const tabs = [
  { id: 'chat', label: 'Chat' },
  { id: 'trajectory', label: 'Trajectory' },
  { id: 'disabled', label: 'Disabled', disabled: true },
]
const rowOpen = ref(true)
const thinkOpen = ref(false)
const menuOpen = ref(false)
const menuAnchor = ref<HTMLElement | null>(null)
const modalOpen = ref(false)
const toastOpen = ref(true)
const permission = ref('workspace-write')
const clockStart = Date.UTC(2026, 0, 1, 0, 0, 0)

const tsSource = `import { ref } from 'vue'

// Count clicks and report them upstream.
export function useCounter(initial = 0) {
  const count = ref<number>(initial)
  const inc = (step = 1) => (count.value += step)
  return { count, inc, label: \`count: \${count.value}\` }
}
`
const oldText = `export function greet(name: string) {
  const who = name.trim()
  console.log('hello ' + who)
  return who
}
`
const newText = `export function greet(name: string) {
  const who = name.trim() || 'world'
  console.info(\`hello \${who}\`)
  return who
}
`
const readLines = tsSource
  .split('\n')
  .slice(0, 7)
  .map((text, index) => ({ number: index + 1, text }))
const terminalOutput =
  '\u001b[32m✓\u001b[0m src/theme/tokens.test.ts (14 tests) 11ms\n' +
  '\u001b[32m✓\u001b[0m src/style-audit.test.ts (18 tests) 40ms\n' +
  '\u001b[1mTest Files\u001b[0m  2 passed (2)\n' +
  '\u001b[33mwarn\u001b[0m 1 snapshot obsolete\n'
const jsonSample = {
  path: 'desktop/src/renderer/src/theme/dark.css',
  offset: 1,
  limit: 200,
  options: { follow: true, encoding: 'utf-8', tags: ['theme', 'dsh'] },
  size: null,
}
</script>

<template>
  <main class="ui-gallery" data-testid="ui-gallery">
    <header class="gallery-head">
      <h1>Emperor · dsh primitives</h1>
      <Tabs v-model="tab" :tabs="tabs" />
    </header>

    <section class="panel">
      <h2>Tokens</h2>
      <div class="swatches">
        <span
          v-for="token in [
            'bg-base',
            'bg-layer-1',
            'bg-layer-2',
            'bg-layer-3',
            'sidebar-fill',
            'code-block-bg',
            'accent-fill',
            'accent-hover',
            'accent-strong',
            'accent-soft',
            'bubble-user',
            'approval',
            'approval-soft',
            'ok',
            'warn',
            'danger',
          ]"
          :key="token"
          class="swatch"
          :style="{ background: `rgb(var(--${token}))` }"
          :title="token"
          ><em>{{ token }}</em></span
        >
      </div>
      <div class="type-scale">
        <span class="t-xxxs">xxxs 11/14</span>
        <span class="t-xxs">xxs 12/18</span>
        <span class="t-xs">xs 13/20</span>
        <span class="t-s">s 14/22</span>
        <span class="t-base">base 16/24</span>
        <span class="t-md">md body 16/28 — 帝王般的对话体验</span>
        <span class="t-code">code 13/22 const x = 1</span>
      </div>
      <div class="labels">
        <span class="l-primary">label-primary</span>
        <span class="l-secondary">label-secondary</span>
        <span class="l-tertiary">label-tertiary</span>
        <span class="l-caption">label-caption</span>
      </div>
      <div class="shadows">
        <span class="shadow lv1">lv1</span>
        <span class="shadow lv2">lv2</span>
        <span class="shadow lv3">lv3</span>
      </div>
    </section>

    <section class="panel">
      <h2>Icons ({{ icons.length }})</h2>
      <div class="icons">
        <span v-for="icon in icons" :key="icon.name" class="icon-cell">
          <component :is="icon.component" :size="16" />
          <em>{{ icon.name.replace(/^Ds/, '') }}</em>
        </span>
      </div>
    </section>

    <section class="panel flow">
      <h2>Flow rows</h2>
      <DisclosureRow
        v-model:open="thinkOpen"
        title="Thought"
        summary="for 12s · inspecting the design tokens"
      >
        <template #icon><DsIcons.DsThink :size="16" /></template>
        <p class="think">I should map dsh blue onto the Emperor gold family.</p>
      </DisclosureRow>
      <DisclosureRow
        title="Bash"
        summary="npm test --workspace @emperor/core"
        running
      >
        <template #icon><StateDot state="ongoing" /></template>
      </DisclosureRow>
      <DisclosureRow
        v-model:open="rowOpen"
        title="Read"
        summary="theme/dark.css"
      >
        <template #icon><DsIcons.DsBrowse :size="16" /></template>
        <template #trailing>
          <Pill interactive><DsIcons.DsInspect :size="12" /> Inspect</Pill>
        </template>
        <InOutCard
          :input="{ path: 'theme/dark.css', limit: 40 }"
          :output="'bg-base → nb-950\nbg-layer-1 → nb-875'"
        />
      </DisclosureRow>
      <DisclosureRow
        title="Edit"
        summary="Permission denied"
        tone="error"
        :expandable="false"
      >
        <template #icon><StateDot state="error" /></template>
      </DisclosureRow>
      <div class="dots">
        <StateDot state="ok" /> ok <StateDot state="warn" /> warn
        <StateDot state="error" /> error <StateDot state="ongoing" /> ongoing
        <Shimmer text="Working…" />
        <ElapsedClock :started-at="clockStart" :ended-at="clockStart + 65000" />
        <Shimmer text="Thinking" tone="neutral" />
      </div>
    </section>

    <section class="panel">
      <h2>Controls</h2>
      <div class="controls">
        <Chip>
          <template #icon><DsIcons.DsPaperclip /></template>
          附件
        </Chip>
        <Chip chevron>
          <template #icon><DsIcons.DsShieldEdit /></template>
          可写工作区
        </Chip>
        <Chip tone="approval">
          <template #icon><DsIcons.DsPlan /></template>
          Plan
        </Chip>
        <Chip tone="accent">Gold chip</Chip>
        <Chip disabled>Disabled</Chip>
        <Pill>Pill</Pill>
        <Pill active>Active</Pill>
        <Pill tone="approval">待审批</Pill>
        <Pill tone="danger">退出码 1</Pill>
        <Tooltip label="Tooltip text" side="bottom">
          <IconButton label="Settings"><DsIcons.DsSettings /></IconButton>
        </Tooltip>
        <IconButton label="Sidebar" round><DsIcons.DsPanelLeft /></IconButton>
        <IconButton label="Send" :size="34" variant="primary">
          <DsIcons.DsArrowUp />
        </IconButton>
        <IconButton label="Stop" :size="34" variant="contrast">
          <DsIcons.DsStopSquare />
        </IconButton>
        <span ref="menuAnchor" class="menu-anchor">
          <Chip chevron :active="menuOpen" @click="menuOpen = !menuOpen">
            Menu
          </Chip>
        </span>
        <Chip @click="modalOpen = true">Open modal</Chip>
      </div>
      <Menu v-model:open="menuOpen" :anchor="menuAnchor" label="Permission">
        <MenuItem variant="label">权限预设</MenuItem>
        <MenuItem
          :selected="permission === 'read-only'"
          description="只读访问工作区"
          @select="permission = 'read-only'"
        >
          <template #icon><DsIcons.DsShieldCheck /></template>
          只读
        </MenuItem>
        <MenuItem
          :selected="permission === 'workspace-write'"
          @select="permission = 'workspace-write'"
        >
          <template #icon><DsIcons.DsShieldEdit /></template>
          可写工作区
        </MenuItem>
        <MenuItem variant="separator" />
        <MenuItem danger @select="permission = 'full'">
          <template #icon><DsIcons.DsShieldAlert /></template>
          完全访问
        </MenuItem>
      </Menu>
      <Modal
        v-model:open="modalOpen"
        title="Confirm"
        description="Modal chrome: mask + blur, radius 24, lv3 shadow."
      >
        <template #footer>
          <Chip @click="modalOpen = false">Cancel</Chip>
          <Chip tone="accent" @click="modalOpen = false">OK</Chip>
        </template>
      </Modal>
      <div class="toast-row">
        <Toast
          v-model:open="toastOpen"
          message="已复制到剪贴板"
          tone="ok"
          inline
          :duration="0"
        />
      </div>
    </section>

    <section class="panel blocks">
      <h2>Blocks</h2>
      <CodeBlock :code="tsSource" lang="ts" />
      <TerminalBlock
        command="npx vitest run src/renderer"
        cwd="/Users/me/emperor-agent/desktop"
        :output="terminalOutput"
        :exit-code="1"
      />
      <TerminalBlock
        command="npm run build"
        cwd="/Users/me"
        home="/Users/me"
        running
      />
      <DiffBlock
        :diffs="[
          { path: 'src/greet.ts', oldText, newText },
          {
            path: 'src/new-file.ts',
            oldText: null,
            newText: 'export const x = 1\n',
          },
        ]"
      />
      <ReadBlock
        label="src/useCounter.ts"
        :lines="readLines"
        :total-lines="42"
      />
      <SearchBlock
        kind="matches"
        :files="[
          {
            path: 'src/theme/dark.css',
            matches: [
              { lineNumber: 86, line: '  accent-fill = 214 172 92' },
              { lineNumber: 92, line: '  bubble-user = 46 43 38' },
            ],
          },
          {
            path: 'src/theme/light.css',
            matches: [{ lineNumber: 86, line: '  accent-fill = 170 122 38' }],
          },
        ]"
        truncated
        :total="12"
      />
      <SearchBlock
        kind="paths"
        :paths="['src/components/ui/Menu.vue', 'src/components/ui/Modal.vue']"
      />
      <WebBlock
        kind="search"
        answer="deepseek-harness is a web client for DeepSeek agents."
        :sources="[
          {
            url: 'https://example.com/dsh',
            title: 'Harness overview',
            snippet: 'Three-column layout, trajectory ledger, inspector.',
            publishedAt: '2026-08-01',
          },
          { url: 'https://example.org/docs' },
        ]"
      />
      <WebBlock
        kind="fetch"
        url="https://example.com/page"
        :status-code="200"
        truncated
      />
      <div class="json-card">
        <JsonTree :value="jsonSample" :expand-depth="2" />
      </div>
    </section>
  </main>
</template>

<style scoped>
.ui-gallery {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  max-width: 820px;
  min-height: 100vh;
  margin: 0 auto;
  padding: var(--space-6);
  background: rgb(var(--bg-base));
  color: rgb(var(--label-primary));
  font: var(--font-s);
}

.gallery-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  border-bottom: 1px solid var(--border-l1);
}

h1 {
  margin: 0;
  font-size: var(--fs-base);
  line-height: var(--lh-base);
  font-weight: 600;
}

h2 {
  margin: 0 0 var(--space-3);
  font: var(--font-xs);
  font-weight: 500;
  color: rgb(var(--label-tertiary));
  text-transform: uppercase;
}

.panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.blocks {
  gap: var(--space-3);
}

.swatches {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: var(--space-2);
}

.swatch {
  display: flex;
  align-items: flex-end;
  height: calc(var(--space-8) + var(--space-6));
  padding: var(--space-1);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-row);
}

.swatch em {
  font-style: normal;
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
  color: rgb(var(--label-primary));
  background: rgb(var(--bg-base) / 0.8);
  border-radius: var(--radius-xs);
  padding: 0 2px;
}

.type-scale,
.labels,
.shadows,
.controls,
.dots {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}

.t-xxxs {
  font: var(--font-xxxs);
}

.t-xxs {
  font: var(--font-xxs);
}

.t-xs {
  font: var(--font-xs);
}

.t-s {
  font: var(--font-s);
}

.t-base {
  font: var(--font-base);
}

.t-md {
  font: var(--font-md);
}

.t-code {
  font: var(--font-code);
}

.l-primary {
  color: rgb(var(--label-primary));
}

.l-secondary {
  color: rgb(var(--label-secondary));
}

.l-tertiary {
  color: rgb(var(--label-tertiary));
}

.l-caption {
  color: rgb(var(--label-caption));
}

.shadow {
  display: grid;
  place-items: center;
  width: calc(var(--space-8) * 3);
  height: calc(var(--space-8) * 2);
  border-radius: var(--radius-card);
  background: rgb(var(--bg-layer-2));
}

.lv1 {
  box-shadow: var(--shadow-lv1);
}

.lv2 {
  box-shadow: var(--shadow-lv2);
}

.lv3 {
  box-shadow: var(--shadow-lv3);
}

.icons {
  display: grid;
  grid-template-columns: repeat(9, 1fr);
  gap: var(--space-1);
}

.icon-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-1);
  border-radius: var(--radius-row);
  color: rgb(var(--label-secondary));
}

.icon-cell:hover {
  background: var(--interactive-bg-hover);
}

.icon-cell em {
  font-style: normal;
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
  color: rgb(var(--label-tertiary));
}

.flow {
  max-width: 748px;
}

.think {
  margin: 0;
  font: var(--font-s);
  color: rgb(var(--label-tertiary));
}

.menu-anchor {
  display: inline-flex;
}

.toast-row {
  display: flex;
}

.json-card {
  border-radius: var(--radius-card);
  background: rgb(var(--bg-layer-1));
  border: 1px solid var(--border-l1);
}
</style>
