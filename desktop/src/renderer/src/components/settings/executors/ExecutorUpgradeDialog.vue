<script setup lang="ts">
/**
 * 升级 Claude Code / Codex? (AGT-13): nothing runs before this. It names
 * the command (the one the install source uses) and what stays untouched
 * — the logins and settings (~/.codex, Emperor's own Claude login), the
 * Codex desktop app — and that the executor takes no new subtasks while
 * its running ones finish first. Without one click (an install Emperor
 * cannot tell, Homebrew offering another version) it shows the command to
 * run in Terminal instead.
 *
 * Props: profileIds (one, or two for 全部升级). Emits: close.
 */
import { computed, ref } from 'vue'
import Button from '../../ui/Button.vue'
import Modal from '../../ui/Modal.vue'
import { writeClipboard } from '../../ui/useCopyFeedback'
import { useExecutorUpgrades } from './executorUpgrades'
import { confirmContent } from './upgradeText'

const props = defineProps<{ profileIds: readonly string[] }>()
const emit = defineEmits<{ close: [] }>()

const upgrades = useExecutorUpgrades()
const items = computed(() =>
  props.profileIds.flatMap((id) => {
    const version = upgrades.versionOf(id)
    return version?.target && version.upgrade ? [version] : []
  }),
)
const content = computed(() => confirmContent(items.value))
const copied = ref(false)
async function copy() {
  copied.value = await writeClipboard(content.value.commands.join('\n'))
}
function close(open: boolean) {
  if (!open) emit('close')
}
function confirm() {
  void upgrades.upgrade(items.value.map((v) => v.profileId))
  emit('close')
}
</script>

<template>
  <Modal
    :open="items.length > 0"
    :title="content.title"
    :width="460"
    @update:open="close"
  >
    <div class="upgrade-dialog" data-upgrade-dialog>
      <p class="lead">{{ content.lead }}</p>
      <code
        v-for="command in content.commands"
        :key="command"
        class="command"
        data-upgrade-command
        >{{ command }}</code
      >
      <ul v-if="content.points.length" class="points">
        <li v-for="point in content.points" :key="point">{{ point }}</li>
      </ul>
    </div>
    <template #footer>
      <template v-if="content.action">
        <Button variant="secondary" data-upgrade-dismiss @click="emit('close')"
          >取消</Button
        ><Button
          variant="primary"
          data-autofocus
          data-upgrade-confirm
          @click="confirm"
          >{{ content.action }}</Button
        >
      </template>
      <template v-else>
        <Button variant="secondary" data-upgrade-copy @click="copy">{{
          copied ? '已复制' : '复制命令'
        }}</Button
        ><Button
          variant="primary"
          data-autofocus
          data-upgrade-dismiss
          @click="emit('close')"
          >知道了</Button
        >
      </template>
    </template>
  </Modal>
</template>

<style scoped>
.upgrade-dialog {
  display: grid;
  gap: var(--space-2-5);
}

.lead {
  margin: 0;
  font: var(--weight-regular) var(--type-caption) var(--font-sans);
  color: rgb(var(--text-2));
}

.command {
  display: block;
  padding: var(--space-2) var(--space-2-5);
  border-radius: var(--r-xs);
  background: rgb(var(--surface-sunken));
  box-shadow: inset 0 0 0 0.5px var(--stroke-2);
  color: rgb(var(--text-1));
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  overflow-wrap: anywhere;
}

.points {
  margin: 0;
  padding-left: var(--space-4);
  list-style: disc;
  font: var(--weight-regular) var(--type-caption) var(--font-sans);
  color: rgb(var(--text-2));
}

.points li + li {
  margin-top: var(--space-1);
}
</style>
