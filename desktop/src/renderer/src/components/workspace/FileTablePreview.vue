<script setup lang="ts">
/**
 * FileTablePreview — a CSV or TSV file of the Files pane as a table
 * (BUG-10): the first row is the header; the first 2000 rows and 50
 * columns are shown (filePreviewModel.parseDelimited), and the note says
 * when there is more. Its source is the pane's code view.
 *
 * Props: table (the parsed rows).
 */
import type { DelimitedTable } from './filePreviewModel'

defineProps<{ table: DelimitedTable }>()
</script>

<template>
  <div class="file-table-wrap">
    <table class="file-table">
      <thead>
        <tr>
          <th v-for="(cell, index) in table.header" :key="index">
            {{ cell }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, rowIndex) in table.rows" :key="rowIndex">
          <td v-for="column in table.columns" :key="column">
            {{ row[column - 1] ?? '' }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
  <small v-if="table.moreRows || table.moreColumns" class="file-table-note">
    {{
      [
        table.moreRows ? '只显示前 2000 行' : '',
        table.moreColumns ? '只显示前 50 列' : '',
      ]
        .filter(Boolean)
        .join(' · ')
    }}
    · 完整内容见「源码」
  </small>
</template>

<style scoped>
.file-table-wrap {
  overflow: auto;
  max-height: 70vh;
  border-radius: var(--r-sm);
  box-shadow: 0 0 0 0.5px var(--hairline);
}

.file-table {
  border-collapse: collapse;
  min-width: 100%;
  color: rgb(var(--text-1));
  font: var(--font-xs);
  font-variant-numeric: tabular-nums;
}

.file-table th,
.file-table td {
  padding: var(--space-1) var(--space-2);
  border-bottom: 0.5px solid var(--hairline);
  text-align: left;
  white-space: pre;
}

.file-table th {
  position: sticky;
  top: 0;
  background: rgb(var(--surface-raised));
  color: rgb(var(--text-2));
  font-weight: var(--weight-medium);
}

.file-table-note {
  display: block;
  margin-top: var(--space-2);
  color: rgb(var(--text-3));
  font: var(--font-xxs);
}
</style>
