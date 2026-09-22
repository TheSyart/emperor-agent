<script setup lang="ts">
/**
 * TrajectoryKindTag — dsh record-kind tag (SYSTEM / USER / CONTEXT /
 * COMPACTED / ASSISTANT / TOOL / SUBTOOL): 19px tinted label that collapses
 * to its 13px icon inside a narrow ledger (the table's `trajectory-table`
 * container query).
 *
 * Props: kind; iconOnly? (always show the icon only).
 */
import type { TrajectoryCellKind } from '../../trajectory/model'
import DsSettings from '../icons/ds/DsSettings.vue'
import DsSparkle from '../icons/ds/DsSparkle.vue'
import DsUser from '../icons/ds/DsUser.vue'
import { TRAJECTORY_KIND_LABEL } from './trajectoryFormat'

withDefaults(defineProps<{ kind: TrajectoryCellKind; iconOnly?: boolean }>(), {
  iconOnly: false,
})
</script>

<template>
  <span
    class="traj-kind-tag"
    :data-kind="kind"
    :data-icon-only="iconOnly || undefined"
    :title="TRAJECTORY_KIND_LABEL[kind]"
  >
    <span class="icon" aria-hidden="true">
      <DsSettings v-if="kind === 'system'" :size="13" />
      <DsUser v-else-if="kind === 'user'" :size="13" />
      <DsSparkle v-else-if="kind === 'message'" :size="13" />
      <svg
        v-else-if="kind === 'context'"
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
      >
        <circle cx="8" cy="8" r="6.7" />
        <circle cx="8" cy="5.5" r=".85" fill="currentColor" stroke="none" />
        <path d="M8 7.75v3.4" stroke-width="1.8" />
      </svg>
      <svg
        v-else-if="kind === 'compacted'"
        width="13"
        height="13"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="m2.5 2.5 3.75 3.75M3 6.25h3.25V3" />
        <path d="m13.5 2.5-3.75 3.75M13 6.25H9.75V3" />
        <path d="m2.5 13.5 3.75-3.75M3 9.75h3.25V13" />
        <path d="m13.5 13.5-3.75-3.75M13 9.75H9.75V13" />
      </svg>
      <svg
        v-else
        width="13"
        height="13"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path
          d="M14 3.3a3.8 3.8 0 0 1-4.8 4.8l-5.1 5.1a1.6 1.6 0 1 1-2.3-2.3l5.1-5.1A3.8 3.8 0 0 1 11.7 1l-2.3 2.3 2.3 2.3L14 3.3Z"
        />
      </svg>
    </span>
    <span class="label">{{ TRAJECTORY_KIND_LABEL[kind] }}</span>
  </span>
</template>

<style scoped>
.traj-kind-tag {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  height: 19px;
  padding: 0 calc(var(--space-1) + 1px);
  border: 1px solid transparent;
  border-radius: var(--space-1);
  font: 650 10px / 16px var(--font-sans);
  letter-spacing: 0.035em;
  white-space: nowrap;
  user-select: none;
  color: rgb(var(--label-secondary));
  background: var(--interactive-bg-hover);
}

.icon {
  display: none;
  align-items: center;
  justify-content: center;
  width: 13px;
  height: 13px;
}

.traj-kind-tag[data-icon-only='true'] {
  width: 19px;
  padding: 0;
}

.traj-kind-tag[data-icon-only='true'] .icon {
  display: inline-flex;
}

.traj-kind-tag[data-icon-only='true'] .label {
  display: none;
}

/* Narrow ledger (TrajectoryTable declares the container). */
@container trajectory-table (max-width: 620px) {
  .traj-kind-tag {
    width: 19px;
    padding: 0;
  }

  .traj-kind-tag .icon {
    display: inline-flex;
  }

  .traj-kind-tag .label {
    display: none;
  }
}

.traj-kind-tag[data-kind='user'] {
  color: rgb(var(--accent-strong));
  background: rgb(var(--accent-soft));
}

.traj-kind-tag[data-kind='context'] {
  color: color-mix(in srgb, rgb(var(--ok)) 68%, rgb(var(--label-secondary)));
  background: rgb(var(--ok-soft));
}

.traj-kind-tag[data-kind='message'] {
  color: rgb(var(--tone-violet));
  background: color-mix(
    in srgb,
    rgb(var(--tone-violet)) 15%,
    rgb(var(--bg-layer-1))
  );
}

.traj-kind-tag[data-kind='tool'] {
  color: rgb(var(--approval-strong));
  background: rgb(var(--approval-soft));
}

.traj-kind-tag[data-kind='subtool'] {
  color: color-mix(
    in srgb,
    rgb(var(--approval-strong)) 62%,
    rgb(var(--label-tertiary))
  );
  background: color-mix(
    in srgb,
    rgb(var(--approval-soft)) 58%,
    rgb(var(--bg-layer-1))
  );
}
</style>
