<script setup lang="ts">
/**
 * TrajectoryGallery — dev-only `?trajectory-gallery` page: TrajectoryView
 * with the inline inspector over an in-memory fixture store (no Electron).
 * Query params:
 * - scenario: kernel | rich | long | live (default rich)
 * - bare: hide the scenario bar (screenshots)
 * - page: events per history page (`all` loads the whole log)
 * - select: record index to select; request: request number to select
 * - tab: inspector tab id; fold: turns | calls
 * - call: Inspect deep link call id (focusCallId)
 * `open-subagent` switches to the child session (with a back link).
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { TrajectoryDetailTab } from '../../../trajectory/model'
import TrajectoryView from '../TrajectoryView.vue'
import { acquireTrajectory } from '../useTrajectory'
import { createGalleryStore } from './galleryStore'
import { GALLERY_SCENARIOS } from './galleryScenarios'

const params = new URLSearchParams(location.search)
const scenarioId = params.get('scenario') ?? 'rich'
const bare = params.has('bare')
const page = params.get('page')
const scenario = (GALLERY_SCENARIOS[scenarioId] ?? GALLERY_SCENARIOS.rich!)()
const gallery = createGalleryStore(scenario.sessions, {
  ...(page === 'all'
    ? { pageEvents: Number.MAX_SAFE_INTEGER }
    : page !== null
      ? { pageEvents: Number(page) }
      : {}),
})
const stack = ref<string[]>([scenario.sessions[0]?.id ?? scenarioId])
const current = computed(() => stack.value.at(-1) ?? scenarioId)
const focusCallId = params.get('call')
const applied = ref<string | null>(null)

function openSubagent(id: string): void {
  if (scenario.sessions.some((session) => session.id === id))
    stack.value = [...stack.value, id]
}

// Deterministic initial selection for screenshots.
const { controller, release } = acquireTrajectory(current.value, gallery.store)
function applyParams(): void {
  const select = params.get('select')
  const request = params.get('request')
  const fold = params.get('fold')
  if (fold === 'turns')
    controller.setCollapsedTurns(
      new Set(
        controller.turns.value.flatMap((turn) =>
          turn.turn === null ? [] : [turn.turn],
        ),
      ),
    )
  if (select !== null) controller.selectRecord(Number(select), { scroll: true })
  if (request !== null) {
    const info = controller.requestNumbers.value.find(
      (candidate) => candidate.number === Number(request),
    )
    if (info !== undefined)
      controller.selectRequest({
        turn: info.turn,
        group: info.group,
        ...(info.seq === undefined ? {} : { seq: info.seq }),
      })
  }
  const tab = params.get('tab')
  if (tab !== null) controller.activateTab(tab as TrajectoryDetailTab)
}

onMounted(() => {
  for (const session of scenario.sessions)
    if (session.live !== undefined)
      setTimeout(() => gallery.startLive(session.id, { intervalMs: 120 }), 400)
  const wait = setInterval(() => {
    if (controller.windowState.value.openState !== 'open') return
    clearInterval(wait)
    applyParams()
    document.documentElement.dataset.trajectoryGalleryReady = 'true'
  }, 20)
})
onBeforeUnmount(() => {
  release()
  gallery.dispose()
})
</script>

<template>
  <div
    class="traj-gallery"
    data-testid="trajectory-gallery"
    :data-scenario="scenarioId"
  >
    <header v-if="!bare" class="bar">
      <span class="brand">Trajectory gallery</span>
      <a
        v-for="(_, id) in GALLERY_SCENARIOS"
        :key="id"
        :href="`?trajectory-gallery&scenario=${id}`"
        class="link"
        :data-active="id === scenarioId || undefined"
        >{{ id }}</a
      >
      <button
        v-if="stack.length > 1"
        type="button"
        class="link"
        @click="stack = stack.slice(0, -1)"
      >
        ← back
      </button>
      <span class="note"
        >{{ current }}{{ applied ? ` · inspected ${applied}` : '' }}</span
      >
    </header>
    <main class="stage">
      <TrajectoryView
        :session-id="current"
        :store="gallery.store"
        :focus-call-id="focusCallId"
        inline-inspector
        @open-subagent="openSubagent"
        @inspect-applied="applied = $event"
      />
    </main>
  </div>
</template>

<style scoped>
.traj-gallery {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: rgb(var(--bg-base));
  color: rgb(var(--label-primary));
}

.bar {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-3);
  height: 36px;
  padding: 0 var(--space-4);
  border-bottom: 1px solid var(--border-l2);
  font: var(--font-xs);
}

.brand {
  font-weight: 600;
}

.link {
  padding: 0;
  border: 0;
  color: rgb(var(--label-tertiary));
  background: transparent;
  cursor: pointer;
  font: inherit;
  text-decoration: none;
}

.link[data-active='true'] {
  color: rgb(var(--accent-strong));
}

.note {
  margin-left: auto;
  color: rgb(var(--label-caption));
  font: var(--font-xxs);
}

.stage {
  display: flex;
  flex: 1;
  min-height: 0;
}
</style>
