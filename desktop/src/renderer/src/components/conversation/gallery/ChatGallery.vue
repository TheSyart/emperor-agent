<script setup lang="ts">
/**
 * ChatGallery — dev-only `?chat-gallery` page: ChatTimeline over an
 * in-memory fixture store (no Electron). Query params:
 * - scenario: showcase | notices | workflow | interactions | streaming |
 *   streaming-reasoning | long | kernel (default showcase)
 * - bare: hide the scenario bar (screenshots)
 * - interval: live replay interval in ms (streaming scenarios)
 * `open-subagent` navigates into fixture child sessions (with a back link);
 * `inspect` shows the call id in a transient note.
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import ChatTimeline from '../ChatTimeline.vue'
import { createFixtureStore } from './fixtureStore'
import { kernelScenario } from './kernelScenario'
import { SCENARIO_BUILDERS, type Scenario } from './scenarios'

const params = new URLSearchParams(location.search)
const scenarioId = params.get('scenario') ?? 'showcase'
const bare = params.has('bare')
const interval = Number(params.get('interval') ?? '60')

function buildScenario(id: string): Scenario {
  if (id === 'kernel') return kernelScenario()
  const builder = SCENARIO_BUILDERS[id] ?? SCENARIO_BUILDERS.showcase!
  return builder(Date.now())
}

const scenario = buildScenario(scenarioId)
const fixture = createFixtureStore(scenario.sessions, {
  ...(scenarioId === 'long' ? { pageMessages: 12 } : {}),
})
const stack = ref<string[]>([scenario.sessions[0]?.id ?? scenarioId])
const current = computed(() => stack.value.at(-1) ?? scenarioId)
const note = ref('')
let noteTimer: ReturnType<typeof setTimeout> | undefined

for (const session of scenario.sessions)
  if (session.live !== undefined)
    setTimeout(
      () =>
        fixture.startLive(session.id, {
          batch: 1,
          intervalMs: Number.isFinite(interval) ? interval : 60,
        }),
      300,
    )

function flash(text: string): void {
  note.value = text
  clearTimeout(noteTimer)
  noteTimer = setTimeout(() => (note.value = ''), 2400)
}

function openSubagent(id: string): void {
  if (scenario.sessions.some((session) => session.id === id))
    stack.value = [...stack.value, id]
  else flash(`子会话 ${id} 不在夹具中`)
}

onBeforeUnmount(() => {
  clearTimeout(noteTimer)
  fixture.dispose()
})

const scenarios = [...Object.keys(SCENARIO_BUILDERS), 'kernel']
</script>

<template>
  <div
    class="chat-gallery"
    data-testid="chat-gallery"
    :data-scenario="scenarioId"
  >
    <header v-if="!bare" class="bar">
      <span class="brand">Chat gallery</span>
      <a
        v-for="id in scenarios"
        :key="id"
        :href="`?chat-gallery&scenario=${id}`"
        class="link"
        :data-active="id === scenarioId || undefined"
        >{{ id }}</a
      >
    </header>
    <div v-if="stack.length > 1" class="crumbs">
      <button type="button" class="back" @click="stack = stack.slice(0, -1)">
        ← 返回父会话
      </button>
      <span class="crumb">{{ current }}</span>
    </div>
    <main class="conversation">
      <ChatTimeline
        :key="current"
        :session-id="current"
        :store="fixture.store"
        @inspect="flash(`Inspect ${$event}`)"
        @open-subagent="openSubagent"
        @edit-message="flash(`编辑：${$event}`)"
      />
    </main>
    <div v-if="note" class="note" role="status">{{ note }}</div>
  </div>
</template>

<style scoped>
.chat-gallery {
  --chat-content-width: 748px;

  display: flex;
  flex-direction: column;
  height: 100vh;
  background: rgb(var(--bg-base));
  color: rgb(var(--label-primary));
  font-family: var(--font-sans);
}

.bar {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border-l2);
  font-size: var(--fs-xs);
}

.brand {
  font-weight: 600;
}

.link {
  color: rgb(var(--label-tertiary));
  text-decoration: none;
}

.link[data-active] {
  color: rgb(var(--accent-strong));
}

.crumbs {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
  font-size: var(--fs-xs);
  color: rgb(var(--label-tertiary));
}

.back {
  padding: 0;
  border: none;
  background: none;
  color: rgb(var(--accent-strong));
  font: inherit;
  cursor: pointer;
}

.conversation {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.note {
  position: fixed;
  right: var(--space-4);
  bottom: var(--space-4);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-row);
  background: rgb(var(--toast-bg));
  color: rgb(var(--toast-fg));
  font-size: var(--fs-xs);
}
</style>
