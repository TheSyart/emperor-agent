<script setup lang="ts">
import { ChevronDown, FileDiff, RotateCcw } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import type { TurnChangeSnapshot } from '../../types'
import { turnChangesHeadline } from './turnChangesModel'

const props = defineProps<{ snapshot: TurnChangeSnapshot }>()
const emit = defineEmits<{ openReview: [paths: string[]] }>()
const expanded = ref(false)
const visibleFiles = computed(() =>
  expanded.value ? props.snapshot.files : props.snapshot.files.slice(0, 3),
)

function openReview(): void {
  emit(
    'openReview',
    props.snapshot.files.map((file) => file.path),
  )
}
</script>

<template>
  <section class="turn-changes-card" aria-label="本次任务文件变更">
    <header>
      <div class="turn-changes-card-summary">
        <FileDiff :size="15" aria-hidden="true" />
        <strong>{{ turnChangesHeadline(snapshot) }}</strong>
        <span>
          <b>+{{ snapshot.additions }}</b>
          <em>−{{ snapshot.deletions }}</em>
          <small v-if="snapshot.binaryFiles"
            >{{ snapshot.binaryFiles }} 个二进制文件</small
          >
        </span>
      </div>
      <button type="button" @click="openReview">Review</button>
    </header>
    <ul v-if="visibleFiles.length">
      <li v-for="file in visibleFiles" :key="`${file.kind}:${file.path}`">
        <span>{{ file.path }}</span>
        <small :class="{ binary: file.binary }">
          <template v-if="file.additions === null || file.deletions === null"
            >binary</template
          >
          <template v-else
            ><b class="stat-add">+{{ file.additions }}</b>
            <i class="stat-del">−{{ file.deletions }}</i></template
          >
        </small>
      </li>
    </ul>
    <button
      v-if="snapshot.files.length > 3"
      type="button"
      class="turn-changes-expand"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      {{ expanded ? '收起' : `显示其余 ${snapshot.files.length - 3} 个文件` }}
      <ChevronDown :size="13" :class="{ rotated: expanded }" />
    </button>
    <p v-if="snapshot.status === 'partial'" class="turn-changes-partial">
      <RotateCcw :size="13" aria-hidden="true" />
      仅展示可精确归因的变更；命令产生的其他改动未计入总数。
    </p>
  </section>
</template>
