<script setup lang="ts">
/**
 * SkillIssues — validation messages of a SKILL.md: errors (error label
 * color) before warnings (warn label color), one 12/18 line each with a
 * leading dot; long paths wrap anywhere. Renders nothing when both are empty.
 *
 * Props: errors?, warnings? (string[]); label? (list aria-label).
 */
withDefaults(
  defineProps<{
    errors?: readonly string[]
    warnings?: readonly string[]
    label?: string
  }>(),
  { errors: () => [], warnings: () => [], label: '校验结果' },
)
</script>

<template>
  <ul
    v-if="errors.length || warnings.length"
    class="skill-issues"
    :aria-label="label"
  >
    <li
      v-for="(message, index) in errors"
      :key="`e${index}`"
      class="issue"
      data-tone="error"
    >
      {{ message }}
    </li>
    <li
      v-for="(message, index) in warnings"
      :key="`w${index}`"
      class="issue"
      data-tone="warn"
    >
      {{ message }}
    </li>
  </ul>
</template>

<style scoped>
.skill-issues {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}

.issue {
  position: relative;
  min-width: 0;
  padding-left: var(--space-3);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  overflow-wrap: anywhere;
}

.issue::before {
  content: '';
  position: absolute;
  top: calc((var(--lh-xxs) - var(--space-1-5)) / 2);
  left: 0;
  width: var(--space-1-5);
  height: var(--space-1-5);
  border-radius: var(--radius-pill);
}

.issue[data-tone='error'] {
  color: rgb(var(--state-error-label));
}

.issue[data-tone='error']::before {
  background: rgb(var(--state-error));
}

.issue[data-tone='warn'] {
  color: rgb(var(--state-warn-label));
}

.issue[data-tone='warn']::before {
  background: rgb(var(--state-warn));
}
</style>
