<script setup lang="ts">
/**
 * TerminalBlock — dsh terminal surface for a shell command: prompt banner
 * (run-state dot + cwd label + command), ANSI-colored output that never
 * soft-wraps, exit-status pill, copy, and a head/tail cap.
 *
 * Props:
 * - command: the command line (multi-line commands get one prompt row each).
 * - cwd?: working directory (shown as its last segment, or `~` for home).
 * - home?: home directory for the `~` collapse.
 * - output?: stdout/stderr text, may contain ANSI escapes.
 * - exitCode? / signal?: settled status; non-zero / any signal shows a pill.
 * - running?: banner-only while the command runs.
 * - maxLines (default 16).
 */
import { computed, ref } from 'vue'
import StateDot from './StateDot.vue'
import Pill from './Pill.vue'
import { ansiClasses, parseAnsiLines } from './ansi'
import { capRows, DEFAULT_BLOCK_MAX_LINES, headTailCap } from './headTailCap'
import { useCopyFeedback } from './useCopyFeedback'
import { promptLabel, terminalStatus } from './terminal'

const props = withDefaults(
  defineProps<{
    command: string
    cwd?: string
    home?: string
    output?: string
    exitCode?: number
    signal?: string
    running?: boolean
    maxLines?: number
  }>(),
  {
    cwd: undefined,
    home: undefined,
    output: '',
    exitCode: undefined,
    signal: undefined,
    running: false,
    maxLines: DEFAULT_BLOCK_MAX_LINES,
  },
)

const expanded = ref(false)
const lines = computed(() => {
  const parsed = parseAnsiLines(props.output ?? '')
  const last = parsed[parsed.length - 1]
  const terminated =
    parsed.length > 1 && last !== undefined && last.every((s) => s.text === '')
  return terminated ? parsed.slice(0, -1) : parsed
})
const empty = computed(() =>
  lines.value.every((line) => line.every((span) => span.text.trim() === '')),
)
const commandLines = computed(() => {
  const body = props.command.endsWith('\n')
    ? props.command.slice(0, -1)
    : props.command
  return body.split('\n')
})
const status = computed(() =>
  terminalStatus(props.running, props.exitCode, props.signal),
)
const cap = computed(() =>
  headTailCap(lines.value.length, props.maxLines, expanded.value),
)
const visible = computed(() => capRows(lines.value, cap.value))
const { copied, copy } = useCopyFeedback(() => props.output ?? '')
</script>

<template>
  <div class="ds-terminal" data-terminal :data-running="running || undefined">
    <div class="header">
      <div class="prompt">
        <span class="sr-only">{{ status.label }}</span>
        <div
          v-for="(line, index) in commandLines"
          :key="index"
          class="prompt-line"
        >
          <StateDot v-if="index === 0" :state="status.dot" class="run-state" />
          <span class="cwd">{{
            index > 0 || cwd === undefined ? '$' : promptLabel(cwd, home)
          }}</span>
          <span class="command" v-text="line" />
        </div>
      </div>
      <Pill v-if="status.pill" class="status">{{ status.pill }}</Pill>
      <button
        v-if="!running && !empty"
        type="button"
        class="copy"
        @click="copy"
      >
        {{ copied ? '复制成功' : '复制' }}
      </button>
    </div>
    <template v-if="!running">
      <div v-if="empty" class="empty">无输出</div>
      <div v-else class="output">
        <div
          v-for="(line, index) in visible.head"
          :key="`h${index}`"
          class="line"
        >
          <span
            v-for="(span, spanIndex) in line"
            :key="spanIndex"
            :class="ansiClasses(span)"
            v-text="span.text"
          />
        </div>
        <button
          v-if="cap.hidden > 0"
          type="button"
          class="expand"
          :aria-expanded="expanded"
          @click="expanded = !expanded"
        >
          {{ expanded ? '收起' : `… 其余 ${cap.hidden} 行` }}
        </button>
        <div
          v-for="(line, index) in visible.tail"
          :key="`t${index}`"
          class="line"
        >
          <span
            v-for="(span, spanIndex) in line"
            :key="spanIndex"
            :class="ansiClasses(span)"
            v-text="span.text"
          />
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ds-terminal {
  --terminal-gutter: calc(var(--space-7) + 2px);

  position: relative;
  overflow: hidden;
  padding-left: var(--terminal-gutter);
  color: rgb(var(--label-primary));
  background: rgb(var(--code-block-bg));
  border-radius: var(--radius-card);
}

.header {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  max-height: 150px;
  margin-left: calc(-1 * var(--terminal-gutter));
  padding: calc(var(--space-2) + 1px) var(--space-3-5)
    calc(var(--space-2) + 1px) var(--terminal-gutter);
  overflow-y: auto;
}

.ds-terminal:not([data-running]) .header {
  border-bottom: 1px solid var(--border-l2);
}

.prompt {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  font: var(--font-code);
}

.prompt-line {
  position: relative;
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
  line-height: var(--lh-code);
}

.run-state {
  position: absolute;
  top: 50%;
  left: calc(-1 * var(--terminal-gutter) + var(--space-2));
  transform: translateY(-50%);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.cwd {
  flex: none;
  color: rgb(var(--label-tertiary));
}

.command {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: pre;
  color: rgb(var(--label-primary));
}

.status {
  position: sticky;
  top: 0;
  flex: none;
  height: var(--lh-code);
  color: rgb(var(--danger));
}

.copy {
  position: sticky;
  top: 0;
  flex: none;
  padding: 0;
  border: none;
  background: rgb(var(--code-block-bg));
  color: rgb(var(--label-secondary));
  font: var(--font-xs);
  line-height: var(--lh-code);
  cursor: pointer;
}

.output {
  padding: var(--space-3) var(--space-3-5) var(--space-3) 0;
  font: var(--font-code);
  overflow: auto;
}

.line {
  min-height: var(--lh-code);
  white-space: pre;
}

.expand {
  display: block;
  width: 100%;
  padding: 0;
  border: none;
  background: transparent;
  color: rgb(var(--label-tertiary));
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.expand:hover {
  color: rgb(var(--label-secondary));
}

.empty {
  padding: var(--space-3) var(--space-3-5) var(--space-3) 0;
  font: var(--font-code);
  color: rgb(var(--label-tertiary));
}

.ansi-black,
.ansi-white {
  color: rgb(var(--label-primary));
}

.ansi-gray {
  color: rgb(var(--label-tertiary));
}

.ansi-red {
  color: rgb(var(--danger));
}

.ansi-green {
  color: rgb(var(--ok));
}

.ansi-yellow {
  color: rgb(var(--warn));
}

.ansi-blue {
  color: rgb(var(--code-constant));
}

.ansi-magenta {
  color: rgb(var(--code-function));
}

.ansi-cyan {
  color: rgb(var(--tone-cyan));
}

.ansi-bold {
  font-weight: 600;
}

.ansi-dim {
  opacity: 0.7;
}

.ansi-italic {
  font-style: italic;
}

.ansi-underline {
  text-decoration: underline;
}
</style>
