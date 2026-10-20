<script lang="ts">
/**
 * SettingsTableRow — one row of a SettingsTable. Each child is one cell, in
 * column order (render an empty element for an empty cell); the row wraps
 * every child in a role=cell box that lines up under its column header.
 * Slots: default (the cells).
 */
import {
  Comment,
  Fragment,
  defineComponent,
  h,
  type VNode,
  type VNodeArrayChildren,
} from 'vue'

function cells(children: VNodeArrayChildren | undefined): VNode[] {
  const out: VNode[] = []
  for (const child of children ?? []) {
    if (Array.isArray(child)) out.push(...cells(child))
    else if (child && typeof child === 'object') {
      if (child.type === Comment) continue
      if (child.type === Fragment)
        out.push(...cells(child.children as VNodeArrayChildren))
      else out.push(child)
    }
  }
  return out
}

export default defineComponent({
  name: 'SettingsTableRow',
  setup(_, { slots }) {
    return () =>
      h(
        'div',
        { class: 'ds-settings-table-row', role: 'row' },
        cells(slots.default?.()).map((cell) =>
          h('div', { class: 'cell', role: 'cell' }, [cell]),
        ),
      )
  },
})
</script>

<style scoped>
.ds-settings-table-row {
  display: grid;
  grid-column: 1 / -1;
  grid-template-columns: subgrid;
  border-top: 1px solid var(--stroke-1);
}

.cell {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  min-height: calc(var(--space-8) + var(--space-4));
  padding: var(--space-2) var(--space-3) var(--space-2) 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--text-1));
  overflow-wrap: anywhere;
}

.cell:first-child {
  padding-left: var(--space-4);
}
</style>
