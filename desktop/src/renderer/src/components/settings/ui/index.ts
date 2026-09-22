/**
 * Settings primitives (dsh settings-panel vocabulary) — how to write a section
 * ============================================================================
 *
 * 1. One file per section: `components/settings/<Name>Section.vue`, mapped
 *    in SettingsModal's SECTION_BODIES (a new section also needs an entry in
 *    settingsSections.ts). Section-only parts live in a sibling folder
 *    (`components/settings/<name>/`); styles stay scoped to those files.
 *
 * 2. The shell owns the chrome. The 54px header already shows the section
 *    title (never render another heading/title bar), the options area pads
 *    0 24px 24px, caps content at 720px (564px in the default 800px panel)
 *    and scrolls vertically. Never set overflow-x: hidden; long values wrap
 *    (overflow-wrap: anywhere) or scroll inside their own box (CodeEditor).
 *
 * 3. Header actions (refresh / primary / secondary) go to the header, never
 *    into the section body:
 *
 *      import { refreshAction, useSettingsHeader } from './settingsHeader'
 *      useSettingsHeader({
 *        actions: () => [
 *          refreshAction(() => reload()),              // ghost ⟳, spins while pending
 *          { id: 'add', label: '新增', kind: 'primary', icon: DsPlus,
 *            menu: [                                   // optional dropdown
 *              { id: 'paste', label: '粘贴 JSON', description: '…', onSelect: openPaste },
 *            ] },
 *          { id: 'save', label: '保存', kind: 'secondary',
 *            disabled: !dirty.value, onClick: () => save() },
 *        ],
 *      })
 *
 *    `actions` is an array, ref or getter (re-evaluated reactively — use a
 *    getter for disabled / conditional actions). Kinds: 'refresh' | 'icon'
 *    (28px ghost IconButton; label = aria name) | 'secondary' (default, 28px
 *    outline capsule) | 'primary' (28px ink capsule). A promise returned by
 *    onClick disables the control until it settles; report errors yourself
 *    (ctx.runSafely / inline Field error). Registrations end on unmount.
 *
 * 4. Layout skeleton:
 *
 *      <SettingsSection intro="一句话说明（可选）">       // container-type: inline-size
 *        <SettingsRow title="主题" description="…"> <Select v-model … /> </SettingsRow>
 *        <SettingsGroup title="执行策略" description="…">
 *          <SettingsRow title="失败回退" label-for="fallback">
 *            <Switch id="fallback" v-model="fallback" />
 *          </SettingsRow>
 *        </SettingsGroup>
 *        <SettingsGroup title="服务器" variant="stack">   // cards 8px apart
 *          <SettingsCard v-for … expandable v-model:open="open[id]" :title :description>
 *            <template #leading><StateDot … /></template>
 *            <template #meta><StatusBadge tone="ok" dot>已连接</StatusBadge></template>
 *            <template #actions><Switch v-model … aria-label="启用" /></template>
 *            <DefinitionList :items="facts" />
 *            <template #footer><Button size="sm" …>保存</Button></template>
 *          </SettingsCard>
 *        </SettingsGroup>
 *      </SettingsSection>
 *
 *    - SettingsRow: text left / control right, 16px vertical padding, l2
 *      hairline (last row drops it); `layout="stacked"` puts the control
 *      under the text; `dense` for list rows. Rows stack automatically when
 *      the section container is < 440px (@container, not the viewport).
 *    - Forms: wrap each control in <Field label hint error> — it wires id,
 *      aria-describedby and aria-invalid into TextField / TextArea /
 *      CodeEditor / Select / SearchField. Buttons stay ui/Button (size="sm"
 *      inside cards / rows).
 *    - Editors that should take the remaining height: <SettingsSection fill>
 *      + <SettingsGroup fill> + <CodeEditor fill />.
 *    - Status colors: StatusBadge / Metric tones, or the tokens
 *      --state-{ok,warn,error}[-soft|-label] (no ad-hoc success/warning names).
 *    - Own container queries: `@container (max-width: …)` inside a
 *      SettingsSection resolves against the section width.
 *    - Dialogs over the panel: ui/Modal. Escape closes only the topmost
 *      layer (ui/modalStack.ts), so no per-dialog Escape guards.
 *
 * Every primitive documents its props / slots / events in its SFC header.
 * Live reference: `?settings-gallery` (dev only; SettingsGallery.vue).
 */
export { default as SettingsSection } from './SettingsSection.vue'
export { default as SettingsGroup } from './SettingsGroup.vue'
export { default as SettingsRow } from './SettingsRow.vue'
export { default as SettingsCard } from './SettingsCard.vue'
export { default as Field } from './Field.vue'
export { default as TextField } from './TextField.vue'
export { default as TextArea } from './TextArea.vue'
export { default as CodeEditor } from './CodeEditor.vue'
export { default as Select } from './Select.vue'
export { default as Switch } from './Switch.vue'
export { default as Segmented } from './Segmented.vue'
export { default as SearchField } from './SearchField.vue'
export { default as EmptyState } from './EmptyState.vue'
export { default as DefinitionList } from './DefinitionList.vue'
export { default as StatusBadge } from './StatusBadge.vue'
export { default as Metric } from './Metric.vue'
export type { DefinitionItem, SegmentedOption, SelectOption } from './types'
export { FIELD_CONTEXT, settingsId, useFieldControl } from './fieldContext'
export {
  refreshAction,
  useSettingsHeader,
  type SettingsHeaderAction,
  type SettingsHeaderActionKind,
  type SettingsHeaderMenuItem,
  type SettingsHeaderOptions,
} from '../settingsHeader'
