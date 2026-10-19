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
 *            <template #leading><Dot … /></template>
 *            <template #meta><Badge tone="ok" variant="dot-label">已连接</Badge></template>
 *            <template #actions><Switch v-model … aria-label="启用" /></template>
 *            <DefinitionList :items="facts" />
 *            <template #footer><Button size="sm" …>保存</Button></template>
 *          </SettingsCard>
 *        </SettingsGroup>
 *      </SettingsSection>
 *
 *    - A SettingsGroup of rows is a card: the title (and one-line
 *      description) above it, the rows inside with 16px sides and inset
 *      hairlines. Put every row of a page in a group — a group without a
 *      title is just the card. `plain` keeps a group flat for content that
 *      brings its own frame (a CodeEditor); `variant="stack"` holds
 *      SettingsCards. Rows, EmptyStates and Selects switch to their card
 *      look by themselves (ui/surface.ts); SettingsCard and Modal reset it.
 *    - A page with a master switch (电脑操作, 浏览器) opens with it:
 *      `<SettingsCard master>` puts its 18px glyph on a gold tile.
 *    - Order a page by what the user decides: the switches and choices
 *      first, then the rest. When something is wrong, show one
 *      Notice at the top (tone warn / error / info, with the fix
 *      buttons) instead of status rows; a page that is fine shows none.
 *    - SettingsRow: text left / control right; `layout="stacked"` puts the
 *      control under the text; `dense` for list rows; `#eyebrow` for a small
 *      label above the title (⚠ 风险升高). Rows stack automatically when
 *      the section container is < 440px (@container, not the viewport).
 *    - Columns of settings (per-site rules): SettingsTable + SettingsTableRow
 *      in a group.
 *    - A sub page about one thing (电脑操作 › Chrome 和 Edge) may open with
 *      SettingsHero (20/28 title, status badge, its own actions); it is the
 *      only heading a section body renders.
 *    - Forms: wrap each control in <Field label hint error> — it wires id,
 *      aria-describedby and aria-invalid into TextField / TextArea /
 *      CodeEditor / Select / SearchField. Buttons stay ui/Button (size="sm"
 *      inside cards / rows).
 *    - Editors that should take the remaining height: <SettingsSection fill>
 *      + <SettingsGroup fill> + <CodeEditor fill />.
 *    - Status colors: Badge / Metric tones, or the tokens
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
export { default as SettingsHero } from './SettingsHero.vue'
export { default as Notice } from '../../ui/Notice.vue'
export { default as SettingsNotice } from './SettingsNotice.vue'
export { default as Checkbox } from '../../ui/Checkbox.vue'
export { default as SettingsTable } from './SettingsTable.vue'
export { default as SettingsTableRow } from './SettingsTableRow.vue'
export { default as SettingsRow } from './SettingsRow.vue'
export { default as SettingsCard } from './SettingsCard.vue'
export { default as Field } from '../../ui/Field.vue'
export { default as TextField } from '../../ui/TextField.vue'
export { default as TextArea } from '../../ui/TextArea.vue'
export { default as CodeEditor } from './CodeEditor.vue'
export { default as Select } from '../../ui/Select.vue'
export { default as Switch } from '../../ui/Switch.vue'
export { default as Segmented } from '../../ui/Segmented.vue'
export { default as SearchField } from '../../ui/SearchField.vue'
export { default as EmptyState } from '../../ui/EmptyState.vue'
export { default as DefinitionList } from './DefinitionList.vue'
export { default as Badge } from '../../ui/Badge.vue'
export { default as StatusBadge } from './StatusBadge.vue'
export { default as Metric } from './Metric.vue'
export type {
  DefinitionItem,
  SegmentedOption,
  SelectOption,
  SettingsTableColumn,
} from './types'
export {
  FIELD_CONTEXT,
  settingsId,
  useFieldControl,
} from '../../ui/fieldContext'
export {
  refreshAction,
  useSettingsHeader,
  type SettingsHeaderAction,
  type SettingsHeaderActionKind,
  type SettingsHeaderMenuItem,
  type SettingsHeaderOptions,
} from '../settingsHeader'
